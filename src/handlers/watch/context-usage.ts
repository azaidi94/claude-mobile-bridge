/**
 * Context-usage threshold notifications for the mirrored-session watch.
 * Each parsed `usage` tail event flows through here so the registry
 * stays current and the user gets one ping per threshold crossing.
 */

import type { Api } from "grammy";
import { debug } from "../../logger";
import { getMessageBus } from "../../messaging";
import {
  recordUsage,
  computeContextPct,
  checkThresholdCrossing,
} from "../../sessions/context-usage";
import { getContextNotifyStep } from "../../settings";
import type { TokenUsage } from "../../types";
import type { WatchState } from "./state";

/**
 * For a mirrored-session watch: record the new usage in the registry,
 * then if the notify step is set, fire a one-shot Telegram message when
 * a new threshold bucket is crossed. Resets the bucket to 0 if observed
 * pct dropped below the last-notified bucket (compact / reset).
 */
export async function maybeNotifyContextCrossing(
  botApi: Api,
  state: WatchState,
  usage: TokenUsage,
): Promise<void> {
  recordUsage(state.sessionId, usage);

  const step = getContextNotifyStep();
  if (step <= 0) return;

  const pct = computeContextPct(usage);
  let prev = state.lastNotifiedBucket ?? 0;
  if (pct < prev) {
    prev = 0;
    state.lastNotifiedBucket = 0;
  }

  const { fire, bucket } = checkThresholdCrossing(prev, pct, step);
  if (!fire) return;

  state.lastNotifiedBucket = bucket;

  await getMessageBus()
    .send({
      chatId: state.chatId,
      threadId: state.threadId,
      content: `⚠️ Context ${pct}%`,
      format: "plain",
      silent: true,
    })
    .catch((err) =>
      debug("context notify failed", {
        err: String(err),
        chatId: state.chatId,
        topic: state.threadId,
        session: state.sessionName,
      }),
    );
}
