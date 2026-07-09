/**
 * Auto-delete a Telegram forum topic when its Claude session ends (P3 Task 6).
 *
 * Keyed on the P2 registry `launchUuid` (via the topic's stored launchUuid),
 * NOT on cwd/name (which would cross-wire siblings) or the rolling `sessionId`
 * (a `/clear` changes it, so a live topic would look dead).
 *
 * Three guards make this safe against the ways a liveness scan lies (the P3b
 * review caught the first two as data-loss bugs):
 *
 *  1. **Seen-alive-this-run only.** `readRegistry()` returns EVERY session ever
 *     launched (records are never pruned), so we must not reap a launchUuid we
 *     never observed alive during THIS bot run — else enabling the reaper would
 *     mass-delete every historical topic. We only reap a launchUuid after we've
 *     seen its `claudePid` live at least once since boot and it then disappears.
 *  2. **Trust the scan only when it's non-empty.** `getRunningClaudeProcesses`
 *     swallows `ps`/`lsof` failures and returns `[]`, which is indistinguishable
 *     from "everything ended". An empty live-pid set therefore reaps NOTHING —
 *     a systemic scan failure can't nuke every topic at once. (Cost: if you
 *     close literally all sessions at once, the last topics leak until one
 *     more session runs; leaking a topic beats deleting a live one.)
 *  3. **Consecutive-miss threshold + startup grace.** A topic is deleted only
 *     after `threshold` consecutive dead ticks and never during the boot grace
 *     window, so a single flaky tick or a restart can't delete a live topic.
 *
 * Cursor sessions are skipped (their liveness isn't known via `ps`/`lsof`, same
 * carve-out as `reconcile`). `/clear` is safe by construction (pid unchanged →
 * live → count resets).
 *
 * **Destructive + outward-facing**, so the IO wrapper (`reapDeadTopics`) is
 * gated behind `CLAUDE_TOPIC_REAPER=1` (default OFF).
 */

import type { RegistryRecord } from "./registry";

export interface ReaperState {
  /** launchUuid → consecutive dead-tick count. */
  deaths: Map<string, number>;
  /** launchUuids observed live at least once THIS run (reap candidates). */
  seenAlive: Set<string>;
}

/**
 * Pure. Given the current registry records, the live claude pids, and the
 * cross-tick state, return the launchUuids whose topics to delete this tick plus
 * the next-tick state. See the file header for the three safety guards.
 */
export function planTopicDeletions(
  records: RegistryRecord[],
  livePids: Set<number>,
  state: ReaperState,
  opts: { threshold: number; inGrace: boolean },
): { toDelete: string[]; deaths: Map<string, number>; seenAlive: Set<string> } {
  const deaths = new Map(state.deaths);
  const seenAlive = new Set(state.seenAlive);
  const toDelete: string[] = [];

  // Record liveness first: anything live now is a reap candidate and its death
  // count resets. (A /clear keeps the same pid, so it stays live here.)
  for (const r of records) {
    if (livePids.has(r.claudePid)) {
      seenAlive.add(r.launchUuid);
      deaths.set(r.launchUuid, 0);
    }
  }

  // Guard 2 + 3: never reap during grace, and never on an untrustworthy
  // (empty) liveness read — refuse to act unless the scan proves it works by
  // returning at least one live pid.
  if (opts.inGrace || livePids.size === 0) {
    return { toDelete, deaths, seenAlive };
  }

  for (const r of records) {
    if (livePids.has(r.claudePid)) continue;
    if (r.source === "cursor") continue; // liveness unknown via ps/lsof (Guard: cursor)
    if (!seenAlive.has(r.launchUuid)) continue; // Guard 1: never alive this run
    const n = (deaths.get(r.launchUuid) ?? 0) + 1;
    if (n >= opts.threshold) {
      toDelete.push(r.launchUuid);
      deaths.delete(r.launchUuid);
      seenAlive.delete(r.launchUuid);
    } else {
      deaths.set(r.launchUuid, n);
    }
  }
  return { toDelete, deaths, seenAlive };
}

/** Consecutive-miss threshold before a topic is deleted (absorbs a flaky tick). */
export const REAP_THRESHOLD = 2;

/** Whether the reaper's destructive IO is enabled (opt-in — see file header). */
export function reaperEnabled(): boolean {
  return process.env.CLAUDE_TOPIC_REAPER === "1";
}

let state: ReaperState = { deaths: new Map(), seenAlive: new Set() };

/** Test seam — reset the cross-tick reaper state. */
export function _resetReaperState(): void {
  state = { deaths: new Map(), seenAlive: new Set() };
}

/**
 * IO wrapper: plan deletions from the given records + live pids and delete each
 * still-bound topic. No-op (returns []) unless `CLAUDE_TOPIC_REAPER=1`. Persists
 * state across ticks at module scope. A failure never throws to the caller (the
 * watcher refresh must not break).
 */
export async function reapDeadTopics(deps: {
  records: RegistryRecord[];
  livePids: Set<number>;
  inGrace: boolean;
  hasTopic: (launchUuid: string) => boolean;
  deleteTopic: (launchUuid: string) => Promise<void>;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}): Promise<string[]> {
  if (!reaperEnabled()) return [];
  const res = planTopicDeletions(deps.records, deps.livePids, state, {
    threshold: REAP_THRESHOLD,
    inGrace: deps.inGrace,
  });
  state = { deaths: res.deaths, seenAlive: res.seenAlive };
  const deleted: string[] = [];
  for (const uuid of res.toDelete) {
    if (!deps.hasTopic(uuid)) continue; // no bound topic / already gone
    try {
      await deps.deleteTopic(uuid);
      deleted.push(uuid);
      deps.log?.("topic-reaper: deleted topic for ended session", {
        launchUuid: uuid,
      });
    } catch (e) {
      deps.log?.("topic-reaper: deleteTopic failed", {
        launchUuid: uuid,
        err: String(e),
      });
    }
  }
  return deleted;
}
