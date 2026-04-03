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
import { scanPortFiles, invalidateScanCache } from "../relay/discovery";
import type { PortFileData } from "../relay/discovery";

const execAsync = promisify(exec);

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const ACTIVE_SESSION_FILE = join(
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
let debounceTimer: Timer | null = null;
const DEBOUNCE_MS = 500;

/**
 * Save active session name to disk for persistence across restarts.
 */
async function saveActiveSession(): Promise<void> {
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
 * Only includes processes with a TTY (filters out orphans).
 * Filters out subagent processes (whose parent is also a claude process).
 */
async function getRunningClaudeProcesses(): Promise<ClaudeProcess[]> {
  const processes: ClaudeProcess[] = [];
  try {
    // Get PIDs and PPIDs of Claude processes with a TTY
    const { stdout: pidOutput } = await execAsync(
      `ps -eo pid,ppid,tty,comm | awk '{n=split($4,a,"/"); base=a[n]} (base == "claude" || $4 ~ /^[0-9]+\\.[0-9]+\\.[0-9]+$/) && $3 != "??" {print $1, $2}'`,
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

    // Filter out subagents: any process whose parent is also a claude process
    const allPids = new Set(entries.map((e) => e.pid));
    const rootEntries = entries.filter((e) => !allPids.has(e.ppid));

    const pids = rootEntries.map((e) => e.pid);
    if (pids.length === 0) return [];

    const ppidMap = new Map(rootEntries.map((e) => [e.pid, e.ppid]));

    // Get working directory for each PID via lsof (single call)
    const { stdout: lsofOutput } = await execAsync(
      `lsof -p ${pids.join(",")} -a -d cwd -Fpn 2>/dev/null`,
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
      try {
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
      } catch {}
    }
  } catch {
    // No claude processes running
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
 */
async function scanSessions(): Promise<SessionInfo[]> {
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
  const portSessionIds = new Set(
    portFiles.flatMap((pf) => (pf.sessionId ? [pf.sessionId] : [])),
  );

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
    return found;
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
        if (Date.now() - mtime > MAX_AGE_MS) continue;

        const parsed = await parseSessionFile(filePath);
        if (!parsed) continue;
        if (!runningDirs.has(parsed.cwd)) continue;

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

    // 1. Add port-file sessions (authoritative, have PIDs)
    const pfs = portsByDir.get(dir) || [];
    for (const pf of pfs) {
      if (dirFound.length >= processCount) break;
      if (pf.sessionId && knownIds.has(pf.sessionId)) continue;
      dirFound.push({
        id: pf.sessionId || "",
        name: "",
        dir,
        lastActivity: pf.startedAt
          ? new Date(pf.startedAt).getTime()
          : Date.now(),
        source: "desktop",
        pid: pf.ppid,
      });
      if (pf.sessionId) knownIds.add(pf.sessionId);
    }

    // 2. Fill remaining slots with JSONL sessions (prefer port-matched, then mtime)
    const candidates = candidatesByDir.get(dir) || [];
    candidates.sort((a, b) => {
      const aMatch = portSessionIds.has(a.info.id) ? 1 : 0;
      const bMatch = portSessionIds.has(b.info.id) ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
      return b.mtime - a.mtime;
    });
    for (const { info: si } of candidates) {
      if (dirFound.length >= processCount) break;
      if (si.id && knownIds.has(si.id)) continue;
      dirFound.push(si);
      if (si.id) knownIds.add(si.id);
    }

    found.push(...dirFound);
  }

  assignPidsToSessions(found, runningProcesses, portFiles);

  return found;
}

/**
 * Assign Claude process PIDs to discovered sessions.
 * Matches by session ID when available, uses relay port files as a bridge,
 * then falls back to dir-based heuristic.
 */
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
 * Refresh the session cache. Returns diff of desktop sessions.
 */
async function refresh(): Promise<SessionDiff> {
  // Snapshot current desktop sessions by name (unique)
  const oldDesktop = new Map<string, { name: string; dir: string }>();
  for (const s of cache.sessions.values()) {
    if (s.source === "desktop") {
      oldDesktop.set(s.name, { name: s.name, dir: s.dir });
    }
  }

  const discovered = await scanSessions();

  // Keep telegram sessions, replace discovered ones
  const telegramSessions: SessionInfo[] = [];
  for (const s of cache.sessions.values()) {
    if (s.source === "telegram") {
      // Keep if active in last 24h
      if (Date.now() - s.lastActivity < MAX_AGE_MS) {
        telegramSessions.push(s);
      }
    }
  }

  // Rebuild cache
  cache.sessions.clear();

  // Add discovered sessions with generated names
  for (const si of discovered) {
    si.name = generateName(si.dir);
    cache.sessions.set(si.name, si);
  }

  // Add telegram sessions back
  for (const si of telegramSessions) {
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

  const removed: { name: string; dir: string }[] = [];
  for (const [name, old] of oldDesktop) {
    if (!newDesktopNames.has(name)) {
      removed.push(old);
      info(`session removed: ${old.name} (${old.dir})`);
    }
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
 * Start watching for session changes.
 */
export async function startWatcher(
  onChange?: (diff: SessionDiff) => void,
): Promise<void> {
  onChangeCallback = onChange || null;

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

  // Watch /tmp for relay port file creation/deletion
  try {
    relayWatcher = watch("/tmp", (event, filename) => {
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
    // /tmp watch not critical
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
}

/**
 * Force immediate refresh.
 */
export async function forceRefresh(): Promise<void> {
  await refresh();
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
 * Get active session.
 */
export function getActiveSession(): { name: string; info: SessionInfo } | null {
  if (!cache.active) return null;
  const info = cache.sessions.get(cache.active);
  if (!info) return null;
  return { name: cache.active, info };
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
 */
export function removeSession(name: string): boolean {
  const deleted = cache.sessions.delete(name);
  if (deleted && cache.active === name) {
    cache.active = null;
    saveActiveSession();
  }
  return deleted;
}
