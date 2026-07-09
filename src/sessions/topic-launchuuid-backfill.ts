/**
 * Pure planner: backfill `launchUuid` onto topic mappings that already have
 * a `sessionId` but no `launchUuid` yet, using the current
 * sessionId → launchUuid map derived from the registry.
 *
 * Additive/observe-only: this only decides what SHOULD be written; the
 * caller (watcher.ts) performs the actual `updateTopicMapping` writes.
 */

import type { TopicMapping } from "../types";

export function topicLaunchUuidBackfillPlan(
  topics: TopicMapping[],
  launchUuidBySessionId: Map<string, string>,
): { sessionName: string; launchUuid: string }[] {
  const out: { sessionName: string; launchUuid: string }[] = [];
  for (const t of topics) {
    if (t.launchUuid || !t.sessionId) continue;
    const uuid = launchUuidBySessionId.get(t.sessionId);
    if (uuid) out.push({ sessionName: t.sessionName, launchUuid: uuid });
  }
  return out;
}
