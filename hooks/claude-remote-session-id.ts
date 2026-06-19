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

const LOG_FILE = join(homedir(), ".claude", "logs", "session-id-hook.log");

function logLine(msg: string): void {
  try {
    mkdirSync(join(homedir(), ".claude", "logs"), { recursive: true });
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
  try {
    input = JSON.parse(raw);
  } catch {
    return; // No parseable stdin — nothing to do.
  }
  const sessionId = input.session_id;
  const cwd = input.cwd;
  if (!sessionId || !cwd) return;

  const candidates = readPortFiles(stateDir());
  if (candidates.length === 0) return; // relay not up yet (e.g. cold startup)

  const ppidMap = buildPpidMap();
  const ancestry = ancestryChain(process.pid, (pid) => ppidMap.get(pid));
  const target = selectPortFile(candidates, cwd, ancestry);
  if (!target) return;

  // Re-read fresh right before writing so a concurrent relay/bot write to a
  // DIFFERENT field (sessionName/topicId) isn't clobbered by stale contents.
  let currentRaw: string;
  try {
    currentRaw = readFileSync(target.file, "utf-8");
  } catch {
    return;
  }
  let current: Record<string, unknown>;
  try {
    current = JSON.parse(currentRaw) as Record<string, unknown>;
  } catch {
    return;
  }
  if (current.sessionId === sessionId) return; // already current — no churn

  try {
    const tmpFile = `${target.file}.tmp`;
    writeFileSync(
      tmpFile,
      JSON.stringify(mergeSessionId(current, sessionId), null, 2),
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
