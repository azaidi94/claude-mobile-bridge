/**
 * Pure decision core for re-anchoring a session→topic binding on inbound.
 *
 * A Telegram message arrives with its origin topic id. When that topic routes
 * to session S, the binding for S *should* point back at the origin topic. This
 * function decides what to do given the current stored mapping and the origin
 * `threadId` — the side effects (store update, watch rebind, logging) live in
 * `reassertSessionTopic`.
 */

import type { TopicMapping } from "../types";

export type TopicRebindAction = "noop" | "create" | "rebind";

export interface TopicRebindPlan {
  action: TopicRebindAction;
  /** Present only when `action === "rebind"` — the topic id being replaced. */
  oldTopicId?: number;
}

/**
 * Decide how to reconcile session S's stored mapping with the origin topic.
 *
 * - no mapping            → `create` (caller lacks dir/id here, so it's a no-op
 *                           in practice; the mapping is born at topic creation)
 * - mapping already at T   → `noop`
 * - mapping points elsewhere → `rebind` (self-heal toward where the user talks)
 */
export function topicRebindPlan(
  current: TopicMapping | undefined,
  threadId: number,
): TopicRebindPlan {
  if (!current) return { action: "create" };
  if (current.topicId === threadId) return { action: "noop" };
  return { action: "rebind", oldTopicId: current.topicId };
}
