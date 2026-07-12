/**
 * Stop-hook summary cards. Renders the "🪝 stop hook blocked/failed" line
 * when a Claude Stop hook reports an error, and triggers any pending /run
 * completion ping for the topic.
 */

import type { Api } from "grammy";
import { escapeHtml } from "../../formatting";
import { debug } from "../../logger";
import { getMessageBus } from "../../messaging";
import type { TailEvent } from "../../sessions/tailer";
import { firePendingRunCompletion } from "./idle-watchdog";
import type { TailDisplayState } from "./state";

export function renderHookSummary(
  botApi: Api,
  state: TailDisplayState,
  event: TailEvent,
  threadId: number | undefined,
): void {
  const h = event.hook;
  if (!h) return;
  const verb = h.preventedContinuation ? "blocked the run" : "failed";
  const tag = h.failingHookName
    ? ` <code>${escapeHtml(h.failingHookName)}</code>`
    : "";
  const trail = h.firstError
    ? `: ${escapeHtml(h.firstError.slice(0, 200))}`
    : "";
  getMessageBus()
    .send({
      chatId: state.chatId,
      threadId,
      content: `🪝 stop hook${tag} ${verb}${trail}`,
      format: "html",
      silent: !h.preventedContinuation,
    })
    .catch((err) =>
      debug("tail hook_summary", {
        err: String(err),
        chatId: state.chatId,
        topic: threadId,
      }),
    );
  firePendingRunCompletion(botApi, state, threadId);
}
