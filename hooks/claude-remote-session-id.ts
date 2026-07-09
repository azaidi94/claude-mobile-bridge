#!/usr/bin/env bun
/**
 * Claude Code SessionStart hook — exact pid→live-session-id attribution.
 *
 * Fires inside each Claude process on startup / clear / resume / compact. Claude
 * passes `{ session_id, cwd, transcript_path, source, ... }` on stdin. The hook
 * writes `session_id` into the channel-relay port file for ITS OWN Claude
 * process, so the bot's watch (which reads the port file's `sessionId` keyed by
 * the relay's `ppid` = the Claude pid) attributes the transcript to the right
 * topic exactly and instantly — no mtime/birthtime guessing, no ≤15s poll lag.
 *
 * This is strictly additive: the relay's own JSONL-scan discovery loop remains
 * the fallback for sessions without this hook installed. On `/clear` the hook
 * advances the port file the moment the new conversation starts, where the poll
 * would lag and (with two sessions diverging in one dir) could cross-wire.
 *
 * Mapping hook → port file: the hook knows its own pid + cwd, not the relay pid.
 * The relay runs as a child of the Claude process, so the port file's `ppid` IS
 * the Claude pid — an ancestor of this hook. We walk the hook's process ancestry
 * and pick the port file (in this cwd) whose `ppid` is the closest ancestor.
 *
 * Hard rules for a SessionStart hook:
 *   - NEVER write to stdout (SessionStart stdout is injected into Claude's
 *     context). Diagnostics go to a log file only.
 *   - ALWAYS exit 0 — a throwing/non-zero hook must never break session start.
 *   - Finish fast: one `ps` + a STATE_DIR readdir, all synchronous.
 *
 * Pure logic (ancestryChain / selectPortFile / mergeSessionId) is exported and
 * fs/process-free so it can be unit-tested — same discipline as
 * src/mcp/channel-relay/session-discovery.ts (which can't be imported because it
 * binds a port on load).
 */

import { homedir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
  appendFileSync,
  mkdirSync,
} from "fs";

// ── Paths (inlined to keep the hook self-contained — it's symlinked into
// ~/.claude/hooks and must not depend on repo-relative imports resolving). ──

/** Must mirror src/paths.ts STATE_DIR so the hook scans the same port files. */
function stateDir(): string {
  return (
    process.env.CLAUDE_TELEGRAM_STATE_DIR ??
    join(homedir(), ".claude-mobile-bridge")
  );
}

const STATE_DIR = stateDir();
const REGISTRY_DIR = join(STATE_DIR, "registry");

const LOG_FILE =
  process.env.CLAUDE_SESSION_ID_HOOK_LOG ??
  join(homedir(), ".claude", "logs", "session-id-hook.log");

function logLine(msg: string): void {
  try {
    mkdirSync(join(LOG_FILE, ".."), { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // Best-effort logging — never let it break the hook.
  }
}

// ── Pure logic (exported for tests) ──────────────────────────────────────

export interface HookPortFile {
  /** Absolute path to the port file (used by the impure write step). */
  file: string;
  cwd?: string;
  ppid?: number;
  sessionId?: string;
}

/**
 * Ancestor pids of `startPid`, closest-first: `[parent, grandparent, …]`.
 * `ppidOf` returns the parent pid of a pid (or undefined if unknown). Stops at
 * pid ≤ 1 (init), an unknown parent, a cycle, or `maxHops`. Excludes `startPid`
 * itself — a port file's `ppid` is never the hook's own pid.
 */
export function ancestryChain(
  startPid: number,
  ppidOf: (pid: number) => number | undefined,
  maxHops = 32,
): number[] {
  const chain: number[] = [];
  const seen = new Set<number>([startPid]);
  let cur = ppidOf(startPid);
  for (let i = 0; i < maxHops; i++) {
    if (cur === undefined || cur <= 1) break;
    if (seen.has(cur)) break; // cycle guard
    chain.push(cur);
    seen.add(cur);
    cur = ppidOf(cur);
  }
  return chain;
}

/**
 * Pick the port file this hook's Claude process owns. Among port files for
 * `cwd` (those with a known `ppid`), return the one whose `ppid` is the CLOSEST
 * ancestor of the hook — that's the Claude process that spawned both the relay
 * and this hook (the relay's `ppid` is the root Claude pid, an ancestor of any
 * hook that process fires).
 *
 * Requires a proven ancestry match — deliberately NO "sole relay in cwd"
 * fallback. That fallback would hijack a sibling's port file in the case this
 * feature exists to fix: a session that fired the (globally-registered) hook but
 * owns no relay of its own (e.g. hand-started without the channel-relay flag),
 * sharing a dir with a sibling that does. Ancestry would correctly miss, but a
 * lone-sibling fallback would then write THIS session's id into the SIBLING's
 * port file and cross-wire its topic. When ancestry can't attribute (only if the
 * `ps` probe failed — essentially never), we no-op and let the relay's poll
 * fallback converge.
 */
export function selectPortFile(
  candidates: readonly HookPortFile[],
  cwd: string,
  ancestry: readonly number[],
): HookPortFile | undefined {
  const inCwd = candidates.filter(
    (c) => c.cwd === cwd && typeof c.ppid === "number",
  );
  for (const pid of ancestry) {
    const hit = inCwd.find((c) => c.ppid === pid);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Merge a fresh `sessionId` into the port file's parsed contents, preserving
 * every other field (`sessionName`, `topicId`, `port`, …) and its key order.
 */
export function mergeSessionId(
  current: Record<string, unknown>,
  sessionId: string,
): Record<string, unknown> {
  return { ...current, sessionId };
}

/**
 * The Claude process pid for this hook. Prefer the relay port file's ppid when
 * it's a known ancestor (the relay is Claude's child, so its ppid IS Claude).
 * Otherwise fall back to the closest ancestor whose command is exactly "claude".
 */
export function deriveClaudePid(
  ancestry: number[],
  commOf: (pid: number) => string | undefined,
  portFilePpid?: number,
): number | undefined {
  if (portFilePpid !== undefined && ancestry.includes(portFilePpid)) {
    return portFilePpid;
  }
  for (const pid of ancestry) {
    if (commOf(pid) === "claude") return pid;
  }
  return undefined;
}

/**
 * Registry record for a single Claude launch — keyed by stable (pid, startTime) pair.
 * On SessionStart, we mint one record per unique launch and store it in the registry,
 * indexed by `launchUuid` so future fires can reuse it.
 */
export interface RegistryRecord {
  launchUuid: string;
  claudePid: number;
  startTime: string;
  sessionId: string;
  cwd: string;
  source: string;
  updatedAt: string;
}

/**
 * Pure function: given an existing registry and a new (claudePid, startTime), decide
 * whether to mint a new launchUuid or reuse an existing one.
 *
 * - If existing has a record matching both pid+startTime: reuse its launchUuid,
 *   update sessionId/source/updatedAt, return isNew=false.
 * - Else: mint a new record with launchUuid=newUuid, return isNew=true.
 *
 * Used to ensure that the same Claude process, even after /clear, always gets the
 * same launchUuid (its stable registry identity) while its sessionId can evolve.
 */
export function mintDecision(
  existing: RegistryRecord[],
  claudePid: number,
  startTime: string,
  sessionId: string,
  cwd: string,
  source: string,
  now: string,
  newUuid: string,
): { record: RegistryRecord; isNew: boolean } {
  const hit = existing.find(
    (r) => r.claudePid === claudePid && r.startTime === startTime,
  );
  if (hit) {
    return {
      record: { ...hit, sessionId, source, updatedAt: now },
      isNew: false,
    };
  }
  return {
    record: {
      launchUuid: newUuid,
      claudePid,
      startTime,
      sessionId,
      cwd,
      source,
      updatedAt: now,
    },
    isNew: true,
  };
}

export type HookOutcome =
  | "updated"
  | "noop_already_current"
  | "write_failed"
  | "bail_bad_stdin"
  | "bail_missing_fields"
  | "bail_no_port_files"
  | "bail_no_ancestry_match"
  | "bail_reread_failed";

export function decideOutcome(input: {
  parsed: boolean;
  sessionId?: string;
  cwd?: string;
  candidateCount: number;
  target?: HookPortFile;
  currentSessionId?: string;
}): HookOutcome {
  if (!input.parsed) return "bail_bad_stdin";
  if (!input.sessionId || !input.cwd) return "bail_missing_fields";
  if (input.candidateCount === 0) return "bail_no_port_files";
  if (!input.target) return "bail_no_ancestry_match";
  if (input.currentSessionId === input.sessionId) return "noop_already_current";
  return "updated";
}

// ── Impure helpers ───────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  let buf = "";
  for await (const chunk of process.stdin) buf += String(chunk);
  return buf;
}

/** Build a pid→ppid map of all processes via a single `ps` call. */
function buildPpidMap(): Map<number, number> {
  const map = new Map<number, number>();
  try {
    const out = execSync("ps -eo pid=,ppid=", { encoding: "utf-8" });
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) map.set(parseInt(m[1]!, 10), parseInt(m[2]!, 10));
    }
  } catch {
    // ps failed — ancestry comes back empty, selectPortFile no-ops, and the
    // relay's own JSONL-scan poll remains as the fallback. We never guess.
  }
  return map;
}

/** Process start timestamp (`ps -o lstart`), used with the pid as a stable key. */
export function startTimeOf(pid: number): string {
  try {
    return execSync(`ps -o lstart= -p ${pid}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Read all RegistryRecords from REGISTRY_DIR (*.json files), silently skip malformed. */
function readRegistryDirSync(): RegistryRecord[] {
  try {
    return readdirSync(REGISTRY_DIR)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          return [
            JSON.parse(
              readFileSync(join(REGISTRY_DIR, f), "utf-8"),
            ) as RegistryRecord,
          ];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** Write a RegistryRecord to REGISTRY_DIR/<launchUuid>.json (mkdir -p first). */
function writeRegistryRecord(rec: RegistryRecord): void {
  mkdirSync(REGISTRY_DIR, { recursive: true });
  writeFileSync(
    join(REGISTRY_DIR, `${rec.launchUuid}.json`),
    JSON.stringify(rec, null, 2),
  );
}

/** Read + parse every channel-relay port file in STATE_DIR. */
function readPortFiles(dir: string): HookPortFile[] {
  const out: HookPortFile[] = [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return out; // STATE_DIR not created yet (no relay has ever run)
  }
  for (const f of files) {
    if (!f.startsWith("channel-relay-") || !f.endsWith(".json")) continue;
    const file = join(dir, f);
    try {
      const data = JSON.parse(readFileSync(file, "utf-8")) as {
        cwd?: string;
        ppid?: number;
        sessionId?: string;
      };
      out.push({
        file,
        cwd: data.cwd,
        ppid: data.ppid,
        sessionId: data.sessionId,
      });
    } catch {
      // Malformed / mid-write — skip.
    }
  }
  return out;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: { session_id?: string; cwd?: string; source?: string };
  let parsed = true;
  try {
    input = JSON.parse(raw);
  } catch {
    parsed = false;
    input = {};
  }
  const sessionId = input.session_id;
  const cwd = input.cwd;

  // Check early bail cases before any I/O.
  const earlyOutcome = decideOutcome({
    parsed,
    sessionId,
    cwd,
    candidateCount: 1, // placeholder — we only need to detect bad_stdin / missing_fields here
  });
  if (
    earlyOutcome === "bail_bad_stdin" ||
    earlyOutcome === "bail_missing_fields"
  ) {
    logLine(
      `bail reason=${earlyOutcome} cwd=${cwd ?? "?"} candidates=0 source=${input.source ?? "?"}`,
    );
    return;
  }

  const ppidMap = buildPpidMap();
  const ancestry = ancestryChain(process.pid, (pid) => ppidMap.get(pid));

  // --- P2: mint/refresh the stable launchUuid — race-free (derived from the
  // process tree, works even before the relay writes its port file) ---
  try {
    if (sessionId && cwd) {
      const commOf = (pid: number): string | undefined => {
        try {
          return execSync(`ps -o comm= -p ${pid}`, {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
          })
            .trim()
            .split("/")
            .pop();
        } catch {
          return undefined;
        }
      };
      const claudePid = deriveClaudePid(ancestry, commOf, undefined);
      if (claudePid !== undefined) {
        const startTime = startTimeOf(claudePid);
        if (startTime) {
          const { record } = mintDecision(
            readRegistryDirSync(),
            claudePid,
            startTime,
            sessionId,
            cwd,
            input.source ?? "unknown",
            new Date().toISOString(),
            crypto.randomUUID(),
          );
          writeRegistryRecord(record);
        }
      }
    }
  } catch (err) {
    logLine(`registry mint failed: ${err}`);
  }

  const candidates = readPortFiles(stateDir());

  if (candidates.length === 0) {
    logLine(
      `bail reason=bail_no_port_files cwd=${cwd ?? "?"} candidates=0 source=${input.source ?? "?"}`,
    );
    return;
  }

  const target = selectPortFile(candidates, cwd!, ancestry);

  if (!target) {
    logLine(
      `bail reason=bail_no_ancestry_match cwd=${cwd ?? "?"} candidates=${candidates.length} source=${input.source ?? "?"}`,
    );
    return;
  }

  // Re-read fresh right before writing so a concurrent relay/bot write to a
  // DIFFERENT field (sessionName/topicId) isn't clobbered by stale contents.
  let currentRaw: string;
  try {
    currentRaw = readFileSync(target.file, "utf-8");
  } catch {
    logLine(
      `bail reason=bail_reread_failed cwd=${cwd ?? "?"} candidates=${candidates.length} source=${input.source ?? "?"}`,
    );
    return;
  }
  let current: Record<string, unknown>;
  try {
    current = JSON.parse(currentRaw) as Record<string, unknown>;
  } catch {
    logLine(
      `bail reason=bail_reread_failed cwd=${cwd ?? "?"} candidates=${candidates.length} source=${input.source ?? "?"}`,
    );
    return;
  }

  if (current.sessionId === sessionId) {
    // noop_already_current — stay silent to avoid log churn on repeated hook fires
    // (e.g. compact events that don't change the session id). The absence of a log
    // line here is intentional; the outcome is benign and expected.
    return;
  }

  try {
    const tmpFile = `${target.file}.tmp`;
    writeFileSync(
      tmpFile,
      JSON.stringify(mergeSessionId(current, sessionId!), null, 2),
    );
    renameSync(tmpFile, target.file);
    logLine(
      `updated ${target.file} sessionId=${sessionId} (was ${String(
        current.sessionId ?? "none",
      )}) source=${input.source ?? "?"}`,
    );
  } catch (err) {
    logLine(
      `write failed for ${target.file}: ${(err as Error)?.message ?? err}`,
    );
  }
}

if (import.meta.main) {
  main()
    .catch((err) => {
      logLine(`fatal: ${err}`);
    })
    .finally(() => process.exit(0));
}
