/**
 * Parent-death detection for the channel-relay MCP server.
 *
 * The relay is an MCP stdio child of `claude`, but neither stdin EOF nor the
 * parent's exit takes it down — its TCP server keeps the event loop alive
 * indefinitely. The orphan then lingers holding a port file that still passes
 * the bot's `isRelayProcess` check, so the bot can connect to a relay whose
 * Claude no longer exists and every message it forwards is silently swallowed.
 *
 * Split out of `server.ts` purely so the decision is unit-testable: importing
 * `server.ts` writes a port file, probes `ps`, and opens a TCP port.
 */

import { execSync } from "child_process";

/**
 * The relay's CURRENT parent pid, read from the OS. Returns null if `ps` fails.
 *
 * Why not `process.ppid`: under Bun (the only runtime this server runs on —
 * `bun run …/server.ts`) `process.ppid` is snapshotted at startup and never
 * changes, even after the process is reparented to launchd/init. Node re-reads
 * it; Bun does not. Reading it would make reparent detection dead code.
 */
export function osParentPid(): number | null {
  try {
    const out = execSync(`ps -p ${process.pid} -o ppid=`, {
      encoding: "utf-8",
    }).trim();
    const n = parseInt(out, 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

export interface ParentProbes {
  /** Current parent pid per the OS, or null when unreadable. */
  currentPpid: () => number | null;
  /** Raw liveness check (signal 0) for a pid. */
  isAlive: (pid: number) => boolean;
}

const defaultProbes: ParentProbes = {
  currentPpid: osParentPid,
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means the process exists but belongs to another user — alive.
      // Only ESRCH is proof it's gone.
      return (err as NodeJS.ErrnoException)?.code === "EPERM";
    }
  },
};

/**
 * True once the claude that spawned us is gone.
 *
 * Reparenting is the primary signal and is genuinely immune to pid reuse: an
 * orphan is adopted by pid 1 (or a subreaper) on both macOS and Linux, so our
 * parent pid no longer matches the one we started under — regardless of what
 * later takes over that pid number. The liveness probe is only the fallback for
 * when `ps` is unreadable, and it IS pid-reuse-vulnerable: a recycled pid reads
 * as a live parent. Fail closed there (treat unreadable as alive) — wrongly
 * exiting a healthy relay is worse than leaving an orphan for the bot-side
 * `isOrphanedRelay` guard to filter.
 */
export function parentIsGone(
  originalPpid: number,
  probes: ParentProbes = defaultProbes,
): boolean {
  const current = probes.currentPpid();
  if (current !== null) return current !== originalPpid;
  return !probes.isAlive(originalPpid);
}
