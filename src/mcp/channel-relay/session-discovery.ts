/**
 * Pure session-id selection for the relay's discovery loop. No fs/process side
 * effects so it can be unit-tested in isolation (server.ts runs a TCP listener
 * + MCP transport on import, so its logic can't be exercised directly).
 */

/** One hour. A JSONL modified this much more recently than the current one is
 * treated as a newer conversation even if birthtime ordering is inverted
 * (handles `claude --resume` of a transcript born before the current one). */
export const RECENCY_ADVANTAGE_MS = 60 * 60 * 1000;

export interface JsonlCandidate {
  id: string;
  birthtimeMs: number;
  mtimeMs: number;
}

/**
 * Pick the session id the relay should adopt after its conversation may have
 * rolled — e.g. `/clear` writes a fresh JSONL in the same dir under the same
 * process, so the launch-time sessionId in the port file goes stale.
 *
 * Returns the NEWEST unclaimed candidate that is genuinely newer than
 * `current`; `undefined` when none qualifies (caller keeps the current id).
 *
 * Why newest-by-mtime + the `claimed` set rather than birthtime-closeness:
 * birthtime-closeness anchors to the relay's start, so after a roll it keeps
 * re-selecting the launch file (`id === currentId`) and never updates — the bug
 * that froze `/clear` follow. Newest-by-mtime always moves forward, and
 * skipping ids already written to OTHER relay port files (`claimed`) partitions
 * sibling relays sharing a directory: each settles on a distinct transcript
 * instead of both grabbing the same newest file.
 *
 * Caveat — the `birthtimeMs >` clause needs reliable birthtime, which holds on
 * macOS/APFS (where the relay runs) but NOT on Linux ext4 (often 0/ctime). On
 * such a platform only the RECENCY_ADVANTAGE_MS mtime branch fires, so a /clear
 * less than an hour after the prior write is missed. Acceptable while the relay
 * is a desktop (macOS) process; a Linux desktop would want a birthtime-free
 * fallback (or a hook-fed live id) here.
 *
 * Attribution is best-effort, not exact: with two sessions actively diverging
 * in one dir, `claimed` only guarantees distinct picks, not that each relay
 * gets its OWN process's transcript. Exact per-process attribution needs a
 * signal this pure function doesn't have (e.g. a Claude hook reporting pid →
 * live session id).
 *
 * Every roll requires STRICT mtime progress (`c.mtimeMs > current.mtimeMs`).
 * Without it the two `isNewer` branches can contradict each other — A "newer"
 * than B by birthtime while B is "newer" than A by the recency-advantage mtime
 * branch — and the 15s loop oscillates A→B→A forever, flapping the port file's
 * sessionId and spamming the bot's watch with "new conversation" rebinds. With
 * it, "newer" is a strict order on mtime, so no cycle is possible. A genuine
 * roll always has mtime progress: a fresh /clear JSONL is written after the old
 * transcript's last line, and a resumed transcript is written on resume.
 */
export function pickRolledSessionId(
  candidates: readonly JsonlCandidate[],
  current: JsonlCandidate,
  claimed: ReadonlySet<string>,
  serverStartedAtMs: number,
): string | undefined {
  let newest: { id: string; mtimeMs: number } | undefined;
  for (const c of candidates) {
    if (c.id === current.id) continue;
    if (claimed.has(c.id)) continue;
    if (c.mtimeMs <= current.mtimeMs) continue;
    const isNewer =
      (c.birthtimeMs > current.birthtimeMs && c.mtimeMs >= serverStartedAtMs) ||
      c.mtimeMs > current.mtimeMs + RECENCY_ADVANTAGE_MS;
    if (!isNewer) continue;
    if (!newest || c.mtimeMs > newest.mtimeMs) {
      newest = { id: c.id, mtimeMs: c.mtimeMs };
    }
  }
  return newest?.id;
}
