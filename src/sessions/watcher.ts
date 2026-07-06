/**
 * Session watcher - auto-discovers Claude Code sessions.
 * Uses fs.watch for instant detection + periodic polling as backup.
 */

import { watch, type FSWatcher } from "fs";
import { readdir, stat, readFile, writeFile, unlink } from "fs/promises";
import { join, basename } from "path";
import { homedir, tmpdir } from "os";
import { exec } from "child_process";
import { promisify } from "util";
import type { SessionInfo } from "./types";
import type { SessionDiff } from "./notifications";
import { info, warn, error } from "../logger";
import { safeAsync } from "../utils/safe-async";
import {
  scanPortFiles,
  invalidateScanCache,
  updatePortFile,
} from "../relay/discovery";
import type { PortFileData } from "../relay/discovery";
import { backfillPortFileSessionIds } from "../relay/backfill";
import { STATE_DIR } from "../paths";
// Imported from the leaf module (not the barrel) to avoid a topics→sessions
// import cycle. Read-only: used to pin session names across restarts.
import { getTopicStore, updateTopicMapping } from "../topics/topic-store";
import { topicSessionIdRefreshPlan } from "./topic-id-refresh";
import { dropSessionState } from "./session-state";
import { reportIdentityViolations } from "./identity-report";
import { shadowCompareIdentities } from "./identity-shadow";
import { resolveIdentities, type ResolvedIdentity } from "./identity";
import { setCurrentSnapshot } from "./resolve-session";

const execAsync = promisify(exec);

export const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const ACTIVE_SESSION_FILE = join(STATE_DIR, "active-session.txt");
const LEGACY_ACTIVE_SESSION_FILE = join(
  tmpdir(),
  "claude-telegram-active-session.txt",
);
const POLL_INTERVAL_MS = 60_000; // 60s backup poll
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

interface SessionCache {
  sessions: Map<string, SessionInfo>; // keyed by name
  active: string | null;
}

// In-memory cache
const cache: SessionCache = {
  sessions: new Map(),
  active: null,
};

let watcher: FSWatcher | null = null;
let relayWatcher: FSWatcher | null = null;
let pollInterval: Timer | null = null;
let onChangeCallback: ((diff: SessionDiff) => void) | null = null;
let watcherStarted = false;
let debounceTimer: Timer | null = null;
const DEBOUNCE_MS = 500;

// Serialization state for refresh()
let refreshInFlight: Promise<SessionDiff> | null = null;
let refreshDirty = false;
let refreshFollowUpTimer: ReturnType<typeof setTimeout> | null = null;

// Test seam: override the real doRefresh() body for unit testing coalesce logic.
let _doRefreshOverride: (() => Promise<SessionDiff>) | null = null;
export function _setDoRefreshForTest(
  fn: (() => Promise<SessionDiff>) | null,
): void {
  _doRefreshOverride = fn;
  // Reset coalesce state so tests start clean, and cancel any pending follow-up
  // timer left over from a previous test run.
  if (refreshFollowUpTimer !== null) {
    clearTimeout(refreshFollowUpTimer);
    refreshFollowUpTimer = null;
  }
  refreshInFlight = null;
  refreshDirty = false;
}

/**
 * Save active session name to disk for persistence across restarts.
 * Only runs when the watcher has been started to avoid test interference.
 */
async function saveActiveSession(): Promise<void> {
  if (!watcherStarted) return;
  try {
    if (cache.active) {
      await writeFile(ACTIVE_SESSION_FILE, cache.active, "utf-8");
    } else {
      await unlink(ACTIVE_SESSION_FILE).catch(() => {});
    }
  } catch {
    // Ignore save errors
  }
}

/**
 * Load active session name from disk.
 */
async function loadActiveSession(): Promise<string | null> {
  try {
    const name = await readFile(ACTIVE_SESSION_FILE, "utf-8");
    return name.trim() || null;
  } catch {
    // fall through to legacy
  }
  try {
    const name = await readFile(LEGACY_ACTIVE_SESSION_FILE, "utf-8");
    const trimmed = name.trim();
    if (trimmed) {
      await writeFile(ACTIVE_SESSION_FILE, trimmed, "utf-8");
      info(
        `watcher: migrated active session from ${LEGACY_ACTIVE_SESSION_FILE} to ${ACTIVE_SESSION_FILE}`,
      );
    }
    return trimmed || null;
  } catch {
    return null;
  }
}

export interface ClaudeProcess {
  pid: number;
  ppid: number;
  dir: string;
  sessionId?: string;
}

/**
 * Get running Claude Code processes with their PIDs and working directories.
 * Filters out subagent processes (whose parent is also a claude process).
 */
async function getRunningClaudeProcesses(): Promise<ClaudeProcess[]> {
  const processes: ClaudeProcess[] = [];
  try {
    // Get PIDs and PPIDs of Claude processes. Drop the TTY filter — the
    // per-pid `!allPids.has(e.ppid)` check below already filters subagents,
    // and `$3 != "??"` was causing legitimate desktop sessions to vanish
    // when their controlling terminal was briefly backgrounded (App Nap,
    // window minimize, brief reparent), leaving auto-watch stuck on a
    // 37s one-shot retry budget that never recovered.
    const { stdout: pidOutput } = await execAsync(
      `ps -eo pid,ppid,comm | awk '{n=split($3,a,"/"); base=a[n]} base == "claude" || $3 ~ /^[0-9]+\\.[0-9]+\\.[0-9]+$/ {print $1, $2}'`,
    );
    const entries = pidOutput
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [pid, ppid] = line.trim().split(/\s+/);
        return { pid: parseInt(pid!), ppid: parseInt(ppid!) };
      });
    if (entries.length === 0) return [];

    // Filter out subagents - drop processes whose parent is also a claude process
    const allPids = new Set(entries.map((e) => e.pid));
    const rootEntries = entries.filter((e) => !allPids.has(e.ppid));

    const pids = rootEntries.map((e) => e.pid);
    if (pids.length === 0) return [];

    const ppidMap = new Map(rootEntries.map((e) => [e.pid, e.ppid]));

    // Get working directory for each PID via lsof (single call).
    // Absolute path: lsof lives in /usr/sbin, which launchd's default PATH omits.
    const { stdout: lsofOutput } = await execAsync(
      `/usr/sbin/lsof -p ${pids.join(",")} -a -d cwd -Fpn 2>/dev/null`,
    );

    let currentPid = 0;
    for (const line of lsofOutput.trim().split("\n")) {
      if (line.startsWith("p")) {
        currentPid = parseInt(line.slice(1));
      } else if (line.startsWith("n") && currentPid) {
        // Normalize worktree paths back to repo root
        let dir = line.slice(1);
        const wtMatch = dir.match(/^(.+)\/\.claude\/worktrees\/.+$/);
        if (wtMatch) dir = wtMatch[1]!;
        processes.push({
          pid: currentPid,
          ppid: ppidMap.get(currentPid) || 0,
          dir,
        });
      }
    }

    // Extract session IDs from process args for precise matching
    if (pids.length > 0) {
      await safeAsync(
        "watcher.ps_args_lookup",
        async () => {
          const { stdout: argsOutput } = await execAsync(
            `ps -p ${pids.join(",")} -o pid=,args= 2>/dev/null`,
          );
          for (const line of argsOutput.trim().split("\n")) {
            const match = line.match(/^\s*(\d+)\s.*--session-id\s+(\S+)/);
            if (match) {
              const proc = processes.find((p) => p.pid === parseInt(match[1]!));
              if (proc) proc.sessionId = match[2];
            }
          }
        },
        { severity: "debug" },
      );
    }
  } catch {
    // silently ok: no claude processes running (ps exits non-zero)
  }
  return processes;
}

/**
 * Parse a session JSONL file to extract session info.
 */
async function parseSessionFile(
  filePath: string,
): Promise<{ sessionId: string; cwd: string } | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean).slice(0, 100);

    let sessionId: string | null = null;
    let cwd: string | null = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId && entry.sessionId !== "null" && !sessionId) {
          sessionId = entry.sessionId;
        }
        if (entry.cwd && entry.cwd !== "null" && !cwd) {
          cwd = entry.cwd;
        }
        if (sessionId && cwd) break;
      } catch {
        // Skip malformed lines
      }
    }

    return sessionId && cwd ? { sessionId, cwd } : null;
  } catch {
    return null;
  }
}

/**
 * Check if string is valid UUID.
 */
function isUuid(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    str,
  );
}

/**
 * Generate unique session name from directory.
 */
function generateName(dir: string): string {
  const base = basename(dir) || "session";

  if (!cache.sessions.has(base)) {
    return base;
  }

  let suffix = 2;
  while (cache.sessions.has(`${base}-${suffix}`)) {
    suffix++;
  }
  return `${base}-${suffix}`;
}

/**
 * Scan ~/.claude/projects for sessions.
 * Only returns sessions with running Claude Code processes.
 *
 * Returns the port files alongside the sessions so callers (refresh()) can
 * reuse them — saves a redundant `scanPortFiles()` call. The cache would
 * have absorbed the duplicate within its 5s TTL anyway, but threading it
 * through is cleaner.
 */
async function scanSessions(): Promise<{
  sessions: SessionInfo[];
  portFiles: PortFileData[];
}> {
  const found: SessionInfo[] = [];

  // Get running Claude processes with individual PIDs
  const runningProcesses = await getRunningClaudeProcesses();

  // Build dir count map for existing logic
  const runningDirs = new Map<string, number>();
  for (const p of runningProcesses) {
    runningDirs.set(p.dir, (runningDirs.get(p.dir) || 0) + 1);
  }

  // Scan port files early for disambiguation
  const portFiles = await scanPortFiles(true);
  setCurrentSnapshot({
    aliveRelays: portFiles,
    topics: getTopicStore().topics,
  });
  const portSessionIds = new Set(
    portFiles.flatMap((pf) => (pf.sessionId ? [pf.sessionId] : [])),
  );
  // Per-session fallback: a present port file is authoritative proof the
  // session is alive even when ps/lsof briefly miss the parent process.
  // Without this, a transient process-detection failure on bot startup
  // demotes the session's JSONL to "stale" and auto-watch never recovers.
  const portDirs = new Set(portFiles.map((pf) => pf.cwd));

  if (runningDirs.size === 0) {
    // Still use port files even with no detected processes
    for (const pf of portFiles) {
      found.push({
        id: "",
        name: "",
        dir: pf.cwd,
        lastActivity: pf.startedAt
          ? new Date(pf.startedAt).getTime()
          : Date.now(),
        source: "desktop",
      });
    }
    return { sessions: found, portFiles };
  }

  // Collect all candidate JSONL sessions per directory, sorted by mtime desc
  const candidatesByDir = new Map<
    string,
    { info: SessionInfo; mtime: number }[]
  >();

  try {
    const projects = await readdir(PROJECTS_DIR);

    for (const project of projects) {
      if (project.startsWith(".")) continue;

      const projectPath = join(PROJECTS_DIR, project);
      const projectStat = await stat(projectPath).catch(() => null);
      if (!projectStat?.isDirectory()) continue;

      const files = await readdir(projectPath);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;

        const sessionId = file.replace(".jsonl", "");
        if (!isUuid(sessionId)) continue;

        const filePath = join(projectPath, file);
        const fileStat = await stat(filePath).catch(() => null);
        if (!fileStat) continue;

        const mtime = fileStat.mtime?.getTime() || 0;

        // Cheap pre-filter: if there are no port files at all, stale JSONLs
        // can be skipped without parsing (portBacked check needs parsed.cwd,
        // but if portDirs is empty it would always be false anyway).
        if (Date.now() - mtime > MAX_AGE_MS && portDirs.size === 0) continue;

        // Parse first so we can check the cwd against the port-file index;
        // an active port file is authoritative proof the session is alive,
        // even if its JSONL has been quiet for > MAX_AGE_MS (idle session).
        const parsed = await parseSessionFile(filePath);
        if (!parsed) continue;
        const portBacked = portDirs.has(parsed.cwd);
        if (!runningDirs.has(parsed.cwd) && !portBacked) continue;
        // Skip stale JSONLs only when no port file vouches for the session.
        if (Date.now() - mtime > MAX_AGE_MS && !portBacked) continue;

        const list = candidatesByDir.get(parsed.cwd) || [];
        list.push({
          info: {
            id: parsed.sessionId,
            name: "",
            dir: parsed.cwd,
            lastActivity: mtime,
            source: "desktop",
          },
          mtime,
        });
        candidatesByDir.set(parsed.cwd, list);
      }
    }
  } catch (err) {
    error(`scan: ${err}`);
  }

  // Build port-file index by dir (authoritative — represents running relays)
  const portsByDir = new Map<string, typeof portFiles>();
  for (const pf of portFiles) {
    const list = portsByDir.get(pf.cwd) || [];
    list.push(pf);
    portsByDir.set(pf.cwd, list);
  }

  // Per-dir assembly: port-file sessions first, then JSONL for remaining slots.
  // Port files represent actual running relays with known PIDs, so they take
  // priority over JSONL-only sessions (which may be stale).
  const allDirs = new Set([...candidatesByDir.keys(), ...portsByDir.keys()]);

  for (const dir of allDirs) {
    const processCount = runningDirs.get(dir) || 1;
    const dirFound: SessionInfo[] = [];
    const knownIds = new Set<string>();

    // Build sessionId→mtime from JSONL candidates for accurate lastActivity
    const candidates = candidatesByDir.get(dir) || [];
    const jsonlMtime = new Map<string, number>();
    // Also track the most recent JSONL session ID for this dir (fallback for port files with no sessionId)
    let mostRecentJsonlId = "";
    let mostRecentJsonlMtime = 0;
    for (const c of candidates) {
      if (c.info.id) {
        jsonlMtime.set(c.info.id, c.mtime);
        if (c.mtime > mostRecentJsonlMtime) {
          mostRecentJsonlMtime = c.mtime;
          mostRecentJsonlId = c.info.id;
        }
      }
    }

    // 1. Add port-file sessions (authoritative, have PIDs).
    // When a port file has no sessionId, consume JSONL candidates sequentially
    // so two port files for the same dir get distinct IDs rather than both
    // falling back to mostRecentJsonlId.
    const pfs = portsByDir.get(dir) || [];
    // Pre-collect explicit port-file sessionIds so they are not offered as
    // fallbacks to a different port file that lacks a sessionId.
    const explicitPfIds = new Set(
      pfs.map((pf) => pf.sessionId).filter(Boolean),
    );
    // Sort by mtime desc (most recent first) so the newest JSONL is preferred.
    // Note: knownIds here contains IDs claimed by previously processed directories,
    // not the current directory's port files (those are in explicitPfIds).
    const unusedFallbacks = [...candidates]
      .sort((a, b) => b.mtime - a.mtime)
      .filter(
        (c) =>
          c.info.id &&
          !knownIds.has(c.info.id) &&
          !explicitPfIds.has(c.info.id),
      )
      .map((c) => c.info.id);
    // Resolve each relay's id via the single shared rule. `unusedFallbacks`
    // still supplies the lone-relay (`missing`) JSONL back-fill; `ambiguous`
    // (a cwd with >1 relay) resolves empty so exact pid (ppid) routing wins.
    const identities = resolveIdentities({ aliveRelays: pfs, topics: [] });
    const identityByRelayPid = new Map(identities.map((i) => [i.relayPid, i]));
    const relayIds = pickRelayIds(
      pfs.map((pf) => identityByRelayPid.get(pf.pid)),
      unusedFallbacks,
    );
    for (let i = 0; i < pfs.length; i++) {
      const pf = pfs[i]!;
      if (dirFound.length >= processCount) break;
      if (pf.sessionId && knownIds.has(pf.sessionId)) continue;
      const resolvedId = relayIds[i]!;
      dirFound.push({
        id: resolvedId,
        name: "",
        dir,
        lastActivity:
          jsonlMtime.get(resolvedId) ??
          (pf.startedAt ? new Date(pf.startedAt).getTime() : Date.now()),
        source: "desktop",
        pid: pf.ppid,
      });
      if (resolvedId) knownIds.add(resolvedId);
    }

    // 2. Fill remaining slots with JSONL sessions, but only if a port file
    //    vouches for them. Headless Agent SDK invocations
    //    (e.g. `claude --print`, `@anthropic-ai/claude-agent-sdk`) write JSONL
    //    files to ~/.claude/projects/ but never open a channel-relay, so they
    //    appear in the JSONL candidate list yet have no port file. Filtering
    //    on `portSessionIds` excludes them — only relay-backed interactive
    //    sessions are registered. Opt out with WATCHER_INCLUDE_HEADLESS=1.
    const includeHeadless = process.env.WATCHER_INCLUDE_HEADLESS === "1";
    candidates.sort((a, b) => {
      const aMatch = portSessionIds.has(a.info.id) ? 1 : 0;
      const bMatch = portSessionIds.has(b.info.id) ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
      return b.mtime - a.mtime;
    });
    for (const { info: si } of candidates) {
      if (dirFound.length >= processCount) break;
      if (si.id && knownIds.has(si.id)) continue;
      if (!includeHeadless && si.id && !portSessionIds.has(si.id)) continue;
      dirFound.push(si);
      if (si.id) knownIds.add(si.id);
    }

    found.push(...dirFound);
  }

  assignPidsToSessions(found, runningProcesses, portFiles);

  return { sessions: found, portFiles };
}

/**
 * Seed the sticky sessionId→name map from the persisted topic store, filling
 * only ids the live in-memory cache didn't already claim (so live truth wins
 * and the store just covers the cold-start gap). Pins each session's name to
 * the id its Telegram topic was created with, surviving restarts where the
 * cache is empty and port-file scan order would otherwise swap sibling names.
 *
 * Note: a port file's own `sessionName` is deliberately NOT used as a seed —
 * the watcher rewrites it every run, so a prior bad assignment would poison
 * it. The topic store is the user-facing source of truth.
 */
export function seedNamesFromTopicStore(
  priorNameById: Map<string, string>,
  topics: { sessionId?: string; sessionName: string }[],
): void {
  for (const t of topics) {
    if (t.sessionId && !priorNameById.has(t.sessionId)) {
      priorNameById.set(t.sessionId, t.sessionName);
    }
  }
}

/**
 * Assign Claude process PIDs to discovered sessions.
 * Matches by session ID when available, uses relay port files as a bridge,
 * then falls back to dir-based heuristic.
 */
/**
 * Compute which relay port files need their `sessionName` rewritten — only the
 * ones whose stored name differs from the session's assigned name. Returning the
 * needed writes (instead of writing unconditionally) keeps a no-op refresh from
 * re-mtime-ing every port file, which would otherwise trip the watcher's own
 * STATE_DIR file-watch and spin a ~1/sec refresh loop. Pure (no I/O) for testing.
 */
export function portFileNameUpdates(
  sessions: Iterable<SessionInfo>,
  portFiles: PortFileData[],
): Array<{ relayPid: number; sessionName: string }> {
  const relayPidBySessionId = new Map<string, number>();
  const relayPidByDirPpid = new Map<string, number>();
  const nameByPid = new Map<number, string | undefined>();
  for (const pf of portFiles) {
    if (pf.sessionId) relayPidBySessionId.set(pf.sessionId, pf.pid);
    if (pf.ppid) relayPidByDirPpid.set(`${pf.cwd}\0${pf.ppid}`, pf.pid);
    nameByPid.set(pf.pid, pf.sessionName);
  }
  const out: Array<{ relayPid: number; sessionName: string }> = [];
  for (const si of sessions) {
    if (si.source !== "desktop" || !si.name) continue;
    const relayPid =
      (si.id ? relayPidBySessionId.get(si.id) : undefined) ??
      (si.pid !== undefined
        ? relayPidByDirPpid.get(`${si.dir}\0${si.pid}`)
        : undefined);
    if (relayPid === undefined) continue;
    if (nameByPid.get(relayPid) === si.name) continue; // already correct — skip
    out.push({ relayPid, sessionName: si.name });
  }
  return out;
}

/**
 * Map each relay's resolved identity to the sessionId the watcher assigns,
 * consuming `unusedFallbacks` (newest unclaimed JSONL ids) ONLY for lone
 * `missing` relays. `ambiguous` siblings resolve to "" and never consume a
 * fallback — guessing one grabs a sibling's transcript and misroutes (the
 * historical bug). Pure (the fallback cursor is local) so it's directly tested.
 * Input order matches the port-file order; output is the id per port file.
 */
export function pickRelayIds(
  identities: Array<ResolvedIdentity | undefined>,
  unusedFallbacks: string[],
): string[] {
  let fallbackIdx = 0;
  return identities.map((i) => {
    if (i?.provenance === "authoritative" && i.sessionId) return i.sessionId;
    if (i?.provenance === "missing")
      return unusedFallbacks[fallbackIdx++] ?? "";
    return ""; // ambiguous (or unknown) — exact pid routing handles it
  });
}

export function assignPidsToSessions(
  sessions: SessionInfo[],
  processes: ClaudeProcess[],
  portFiles?: PortFileData[],
): void {
  // Build lookup maps for O(1) matching
  const procBySessionId = new Map<string, ClaudeProcess>();
  for (const p of processes) {
    if (p.sessionId) procBySessionId.set(p.sessionId, p);
  }

  // First pass: match by session ID from process args (authoritative)
  const matched = new Set<number>();
  for (const s of sessions) {
    if (!s.id) continue;
    const proc = procBySessionId.get(s.id);
    if (proc) {
      s.pid = proc.pid;
      matched.add(proc.pid);
    }
  }

  // Second pass: use relay port files as a bridge.
  // Port files have both sessionId and ppid (Claude PID), so if
  // portFile.sessionId matches session.id, we can assign portFile.ppid.
  if (portFiles?.length) {
    const pfBySessionId = new Map<string, PortFileData>();
    for (const pf of portFiles) {
      if (pf.sessionId) pfBySessionId.set(pf.sessionId, pf);
    }
    for (const s of sessions) {
      if (s.pid || !s.id) continue;
      const pf = pfBySessionId.get(s.id);
      if (pf?.ppid && !matched.has(pf.ppid)) {
        s.pid = pf.ppid;
        matched.add(pf.ppid);
      }
    }
  }

  // Third pass: dir-based fallback only when there is exactly one live
  // unmatched process for the directory. Multiple matches are ambiguous.
  const unmatched = sessions.filter((s) => !s.pid);
  if (unmatched.length === 0) return;

  const sessionsByDir = new Map<string, SessionInfo[]>();
  for (const s of unmatched) {
    const list = sessionsByDir.get(s.dir) || [];
    list.push(s);
    sessionsByDir.set(s.dir, list);
  }

  const processesByDir = new Map<string, number[]>();
  for (const p of processes) {
    if (matched.has(p.pid)) continue;
    const list = processesByDir.get(p.dir) || [];
    list.push(p.pid);
    processesByDir.set(p.dir, list);
  }

  for (const [dir, dirSessions] of sessionsByDir) {
    const pids = processesByDir.get(dir);
    if (!pids || pids.length === 0) continue;

    if (pids.length === 1 && dirSessions.length === 1) {
      for (const s of dirSessions) s.pid = pids[0];
    } else if (pids.length > 1 || dirSessions.length > 1) {
      warn(
        `watcher: ambiguous pid assignment for ${dir} (${dirSessions.length} sessions, ${pids.length} processes)`,
      );
    }
  }
}

/**
 * Inner refresh implementation. Contains the real scan + cache-update logic.
 * Call via the serialized `refresh()` wrapper — do not call directly.
 */
async function doRefresh(): Promise<SessionDiff> {
  // Backfill sessionId onto any alive port file that lacks one BEFORE we
  // resolve sessions, so a session that appeared after startup (its port file
  // landed via the STATE_DIR watch that triggered this refresh) is identified
  // on the same tick instead of waiting for a bot restart. Idempotent and
  // cheap when every port file already has its id. (The old once-at-startup
  // sweep never re-ran, so post-startup siblings stayed id-less indefinitely.)
  await backfillPortFileSessionIds();

  // Snapshot current desktop sessions by name (unique). Capture id/pid so a
  // port-backed re-injection (below) can preserve them rather than blanking
  // them out — downstream code uses `session.id` as a lookup key.
  const oldDesktop = new Map<
    string,
    { name: string; dir: string; id: string; pid?: number }
  >();
  // Map prior session ids/pids to their names so names stay sticky across
  // refreshes — otherwise port-file iteration order can swap base name
  // between two sessions sharing a dir, breaking topic mapping.
  const priorNameById = new Map<string, string>();
  const priorNameByPid = new Map<number, string>();
  for (const s of cache.sessions.values()) {
    if (s.source === "desktop") {
      oldDesktop.set(s.name, {
        name: s.name,
        dir: s.dir,
        id: s.id,
        pid: s.pid,
      });
      if (s.id) priorNameById.set(s.id, s.name);
      if (s.pid !== undefined) priorNameByPid.set(s.pid, s.name);
    }
  }

  // Cold-start stickiness: after a bot restart `cache.sessions` is empty, so
  // the in-memory priors above are too. Without a persistent anchor, two
  // sessions sharing a dir get (re)named in nondeterministic port-file scan
  // order — swapping which session owns which name, and therefore which
  // Telegram topic streams which session. Seed from the persisted topic store
  // so names stay pinned to the ids they were created with.
  seedNamesFromTopicStore(priorNameById, getTopicStore().topics);

  const { sessions: discovered, portFiles } = await scanSessions();

  // Re-anchor each topic's stored sessionId to its live port file (matched by
  // topicName). After a desktop /clear the session id changes and the port file
  // is refreshed, but the topic store keeps the old id — breaking sessionId-keyed
  // routing (e.g. the AUQ bridge 404s, then the cwd fallback fails once the
  // session works in a subdir). Sibling-safe: skips topics two live port files
  // disagree on. Only writes on an actual change.
  for (const { sessionName, sessionId } of topicSessionIdRefreshPlan(
    portFiles,
    getTopicStore().topics,
  )) {
    updateTopicMapping(sessionName, { sessionId });
    info(`identity: topic ${sessionName} sessionId refreshed → ${sessionId}`);
  }

  // Keep non-desktop sessions (telegram, cursor); only desktop sessions are
  // rebuilt from filesystem scan. Without this, every refresh drops the
  // cursor sessions added by addCursorSession() and they vanish from the API.
  const preservedSessions: SessionInfo[] = [];
  for (const s of cache.sessions.values()) {
    if (s.source === "telegram" || s.source === "cursor") {
      if (Date.now() - s.lastActivity < MAX_AGE_MS) {
        preservedSessions.push(s);
      }
    }
  }

  // Rebuild cache
  cache.sessions.clear();

  // Restore prior names first, then generate fresh names for the rest.
  // Splitting prevents a freshly-spawned sibling from grabbing the base
  // name before the incumbent's entry is re-registered.
  const needsNewName: SessionInfo[] = [];
  for (const si of discovered) {
    const prior =
      (si.id ? priorNameById.get(si.id) : undefined) ??
      (si.pid !== undefined ? priorNameByPid.get(si.pid) : undefined);
    if (prior && !cache.sessions.has(prior)) {
      si.name = prior;
      cache.sessions.set(prior, si);
    } else {
      needsNewName.push(si);
    }
  }
  for (const si of needsNewName) {
    si.name = generateName(si.dir);
    cache.sessions.set(si.name, si);
  }

  // Add preserved (telegram + cursor) sessions back
  for (const si of preservedSessions) {
    // Re-generate name in case of conflict
    if (cache.sessions.has(si.name)) {
      si.name = generateName(si.dir);
    }
    cache.sessions.set(si.name, si);
  }

  // Compute diff by name (unique per session)
  const newDesktopNames = new Set<string>();
  for (const s of cache.sessions.values()) {
    if (s.source === "desktop") newDesktopNames.add(s.name);
  }

  const added: SessionInfo[] = [];
  for (const s of cache.sessions.values()) {
    if (s.source === "desktop" && !oldDesktop.has(s.name)) {
      added.push(s);
      info(`session found: ${s.name} (${s.dir})`);
    }
  }

  // A live port file is authoritative proof the relay MCP (and therefore
  // the parent Claude) is alive. Filter spurious removes that come from a
  // momentary process-scan miss — those used to cancel the 2s flap-buffer
  // in createNotificationHandler, killing the topic-create for sessions
  // like cdm-model-generation-service that re-appeared after a restart.
  // Reuse the port files that scanSessions() already collected.
  const livePortDirs = new Set(portFiles.map((pf) => pf.cwd));

  const removed: { name: string; dir: string }[] = [];
  for (const [name, old] of oldDesktop) {
    if (newDesktopNames.has(name)) continue;
    if (livePortDirs.has(old.dir)) {
      // Re-add the prior session entry so subsequent refreshes don't re-emit
      // it as `added` once the process scan recovers — the cache already
      // dropped it during the rebuild above. Preserve the prior id/pid so
      // session.id-keyed lookups (relay client, JSONL tailer) still work.
      const prior = cache.sessions.get(name);
      if (!prior) {
        cache.sessions.set(name, {
          id: old.id,
          name,
          dir: old.dir,
          lastActivity: Date.now(),
          source: "desktop",
          ...(old.pid !== undefined ? { pid: old.pid } : {}),
        });
      }
      continue;
    }
    removed.push({ name: old.name, dir: old.dir });
    info(`session removed: ${old.name} (${old.dir})`);
  }

  // Write each desktop session's assigned name back to its relay port file —
  // but ONLY when it actually changed. An unconditional write trips the
  // watcher's own STATE_DIR file-watch, which schedules another refresh, which
  // writes again: a ~1/sec self-trigger loop. Skipping no-op writes breaks it.
  for (const { relayPid, sessionName } of portFileNameUpdates(
    cache.sessions.values(),
    portFiles,
  )) {
    updatePortFile(relayPid, { sessionName });
  }

  // Observe-only (WS-1): surface identity disagreement; changes no routing.
  try {
    reportIdentityViolations({
      sessions: getSessions(),
      topics: getTopicStore().topics,
      portFiles,
    });
  } catch (err) {
    warn(`identity: invariant check failed: ${err}`);
  }

  // Shadow-only (WS-3b): bidirectional — also flag registry ids the resolver doesn't reproduce.
  try {
    shadowCompareIdentities({
      portFiles,
      topics: getTopicStore().topics,
      registrySessions: getSessions()
        .filter((s) => s.source === "desktop" && s.id && s.pid)
        .map((s) => ({ claudePid: s.pid!, sessionId: s.id })),
    });
  } catch (err) {
    warn(`identity-shadow: comparison failed: ${err}`);
  }

  // Validate active session
  if (cache.active && !cache.sessions.has(cache.active)) {
    cache.active = null;
  }

  // Auto-select if none active
  if (!cache.active && cache.sessions.size > 0) {
    // Try to restore persisted active session
    const persisted = await loadActiveSession();
    if (persisted && cache.sessions.has(persisted)) {
      cache.active = persisted;
    } else {
      // Pick most recent
      let mostRecent: SessionInfo | null = null;
      for (const s of cache.sessions.values()) {
        if (!mostRecent || s.lastActivity > mostRecent.lastActivity) {
          mostRecent = s;
        }
      }
      if (mostRecent) {
        cache.active = mostRecent.name;
      }
    }
  }

  return { added, removed };
}

/**
 * Serialized refresh wrapper. Ensures only one doRefresh() runs at a time.
 * Concurrent callers coalesce onto the in-flight promise. If a new call arrives
 * while one is running, a single follow-up run is scheduled via a dirty flag.
 */
async function refresh(): Promise<SessionDiff> {
  if (refreshInFlight) {
    refreshDirty = true;
    return refreshInFlight;
  }
  const doRun = async (): Promise<SessionDiff> => {
    try {
      const fn = _doRefreshOverride ?? doRefresh;
      return await fn();
    } finally {
      refreshInFlight = null;
      if (refreshDirty) {
        refreshDirty = false;
        // Defer so callers awaiting the current run get their result first
        // before the follow-up scan starts (keeps scanCount assertions clean
        // and avoids re-entering synchronously during the finally block).
        refreshFollowUpTimer = setTimeout(() => {
          refreshFollowUpTimer = null;
          refresh().catch(() => {});
        }, 0);
      }
    }
  };
  refreshInFlight = doRun();
  return refreshInFlight;
}

/**
 * Start watching for session changes.
 */
export async function startWatcher(
  onChange?: (diff: SessionDiff) => void,
): Promise<void> {
  onChangeCallback = onChange || null;
  watcherStarted = true;

  // Initial scan (no notifications on startup)
  await refresh();
  info(
    `watcher: ${cache.sessions.size} session${cache.sessions.size !== 1 ? "s" : ""}`,
  );

  // Start fs.watch on projects directory
  try {
    watcher = watch(PROJECTS_DIR, { recursive: true }, (event, filename) => {
      // Only trigger on file creation/deletion ('rename'), not content changes ('change')
      if (event === "rename" && filename?.endsWith(".jsonl")) {
        // Debounce rapid events
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          const diff = await refresh();
          if (diff.added.length || diff.removed.length) {
            onChangeCallback?.(diff);
          }
        }, DEBOUNCE_MS);
      }
    });
    info(`watcher: watching ${PROJECTS_DIR}`);
  } catch (err) {
    warn(`watcher: fs.watch failed, polling only: ${err}`);
  }

  // Watch STATE_DIR for relay port file creation/deletion
  try {
    relayWatcher = watch(STATE_DIR, (event, filename) => {
      if (
        filename?.startsWith("channel-relay-") &&
        filename.endsWith(".json")
      ) {
        invalidateScanCache();
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          const diff = await refresh();
          if (diff.added.length || diff.removed.length) {
            onChangeCallback?.(diff);
          }
        }, DEBOUNCE_MS);
      }
    });
  } catch {
    // STATE_DIR watch not critical
  }

  // Backup polling
  pollInterval = setInterval(async () => {
    const diff = await refresh();
    if (diff.added.length || diff.removed.length) {
      onChangeCallback?.(diff);
    }
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the watcher.
 */
export function stopWatcher(): void {
  watcher?.close();
  watcher = null;
  relayWatcher?.close();
  relayWatcher = null;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  // A coalesced refresh may have scheduled a 0ms follow-up scan — cancel it
  // so nothing mutates the session cache after stop.
  if (refreshFollowUpTimer !== null) {
    clearTimeout(refreshFollowUpTimer);
    refreshFollowUpTimer = null;
  }
  refreshDirty = false;
  watcherStarted = false;
}

/**
 * Force immediate refresh.
 */
export async function forceRefresh(): Promise<SessionDiff> {
  return refresh();
}

/**
 * Get all sessions.
 */
export function getSessions(): SessionInfo[] {
  return Array.from(cache.sessions.values()).sort(
    (a, b) => b.lastActivity - a.lastActivity,
  );
}

/**
 * Read the currently-pinned active session name, if any. Mirrors the
 * `cache.active` slot persisted to ACTIVE_SESSION_FILE; the v1 offline
 * picker and a couple of legacy tests still observe this. Production code
 * should resolve sessions by name explicitly (via topic-router or sctx),
 * not via this global pointer.
 */
export function getActiveSessionName(): string | null {
  return cache.active;
}

/**
 * Set active session by name.
 */
export function setActiveSession(name: string): boolean {
  if (!cache.sessions.has(name)) return false;
  cache.active = name;
  saveActiveSession(); // persist
  return true;
}

/**
 * Get session by name.
 */
export function getSession(name: string): SessionInfo | null {
  return cache.sessions.get(name) || null;
}

/**
 * Add a telegram-created session.
 */
export function addTelegramSession(
  dir: string,
  explicitName?: string,
): SessionInfo {
  const name = explicitName?.trim() || generateName(dir);

  const info: SessionInfo = {
    id: "", // Set when first message sent
    name,
    dir,
    lastActivity: Date.now(),
    source: "telegram",
  };

  cache.sessions.set(name, info);
  cache.active = name;
  saveActiveSession(); // persist

  return info;
}

/**
 * Register a Cursor IDE workspace as a session.
 * Safe to call repeatedly — will not create duplicates. Re-registration is
 * idempotent and intentionally does NOT bump `lastActivity` (task 8): the
 * field must reflect real user-driven activity (a message sent / received),
 * not the cursor-bridge attach/reconnect cadence. Bumping it here made every
 * CDP reconnect mark the session "most-recently active", which fed downstream
 * heuristics that picked the wrong session (e.g. dir-match fallback in
 * sendViaRelay). Real activity is bumped via `updateSessionActivity` from
 * `cursor/bridge.ts` on actual binding events.
 *
 * Note: unlike addTelegramSession, this does NOT set cache.active —
 * Cursor sessions should not auto-steal the active session slot.
 */
export function addCursorSession(opts: {
  name: string;
  dir: string;
  sessionId?: string;
}): void {
  if (!opts.name.trim() || !opts.dir.trim()) return;
  const existing = cache.sessions.get(opts.name);
  if (existing) {
    // Intentionally do NOT touch existing.lastActivity here. See docstring.
    if (opts.sessionId) existing.id = opts.sessionId;
    return;
  }
  // Cursor sessions don't have a Claude SDK session id; use the session name
  // so the web API surfaces a non-empty id for URL routing.
  const info: SessionInfo = {
    id: opts.sessionId ?? opts.name,
    name: opts.name,
    dir: opts.dir,
    lastActivity: Date.now(),
    source: "cursor",
  };
  cache.sessions.set(opts.name, info);
  onChangeCallback?.({ added: [info], removed: [] });
}

/**
 * Update session ID (after first message creates Claude session).
 */
export function updateSessionId(name: string, sessionId: string): void {
  const info = cache.sessions.get(name);
  if (info) {
    info.id = sessionId;
    info.lastActivity = Date.now();
  }
}

/**
 * Update session activity timestamp.
 */
export function updateSessionActivity(name: string): void {
  const info = cache.sessions.get(name);
  if (info) {
    info.lastActivity = Date.now();
  }
}

/**
 * Remove a session from the cache.
 * Also drops the associated SessionState so recycled names don't inherit
 * stale sessionId / pendingPlanApproval / listeners.
 */
export function removeSession(name: string): boolean {
  const deleted = cache.sessions.delete(name);
  if (deleted) {
    dropSessionState(name);
    if (cache.active === name) {
      cache.active = null;
      saveActiveSession();
    }
  }
  return deleted;
}
