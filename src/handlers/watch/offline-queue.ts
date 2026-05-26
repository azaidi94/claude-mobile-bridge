/**
 * Bridge-health offline queue: when bridge-health flips offline, the event
 * router increments WatchState.skippedWhileOffline instead of sending. When
 * the bridge comes back, this module emits one summary per topic.
 */

import type { Api } from "grammy";
import { warn } from "../../logger";
import { getMessageBus } from "../../messaging";
import { watches } from "./registry";

/**
 * Bridge-recovery hook. Walks active watches and sends one summary per
 * topic for any events that were dropped while bridge-health was offline.
 * Called from index.ts when bridge-health flips back online.
 */
export async function flushBridgeReconnectSummaries(
  _botApi: Api,
): Promise<void> {
  for (const state of watches.values()) {
    const skipped = state.skippedWhileOffline ?? 0;
    if (skipped === 0) continue;
    state.skippedWhileOffline = 0;
    try {
      const res = await getMessageBus().send({
        chatId: state.chatId,
        threadId: state.threadId,
        content: `⏸ <i>Skipped ${skipped} watch event${skipped === 1 ? "" : "s"} while bridge was offline. Scroll the desktop JSONL for full history.</i>`,
        format: "html",
        silent: true,
      });
      if ("dropped" in res) {
        warn(`watch: flush reconnect summary dropped: ${res.dropped}`);
      }
    } catch (err) {
      warn(`watch: flush reconnect summary failed: ${err}`);
    }
  }
}
