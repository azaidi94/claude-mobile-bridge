/**
 * Tool-result rendering. Errors always promote to their own Telegram
 * message; successes only promote for the tools listed in
 * `PROMOTE_ON_SUCCESS`. Dense tools (Read/Write/Edit) stay ephemeral.
 */

import type { Api } from "grammy";
import { formatToolResultSummary } from "../../formatting";
import { debug } from "../../logger";
import { getMessageBus } from "../../messaging";
import type { TailEvent } from "../../sessions/tailer";
import { busStubMessage, type TailDisplayState } from "./state";

// Tools whose successful results get promoted to their own Telegram message
// (survive subsequent text streaming). Dense tools (Read/Write/Edit) stay
// ephemeral. Errors always promote, regardless of tool.
const PROMOTE_ON_SUCCESS = new Set([
  "Bash",
  "Grep",
  "Glob",
  "Task",
  "Agent",
  "WebFetch",
  "WebSearch",
]);

export function renderToolResult(
  botApi: Api,
  state: TailDisplayState,
  event: TailEvent,
  threadId: number | undefined,
): void {
  const { chatId } = state;
  const trackProgress = (msg: import("grammy/types").Message) => {
    state.progressMessages?.push(msg);
  };

  const toolName = state.toolUseRegistry?.get(event.toolUseId ?? "");
  const shouldPromote =
    event.isError === true || PROMOTE_ON_SUCCESS.has(toolName ?? "");

  // Free the registry entry regardless of promotion decision.
  state.toolUseRegistry?.delete(event.toolUseId ?? "");

  if (!shouldPromote) return;

  // Follow the same delete-and-resend rhythm as case "tool" so the
  // promoted result message becomes the new in-flight indicator: the
  // previous tool message visibly explodes (Telegram client animation),
  // the result message takes its place, and the next tool/text will
  // cycle it out the same way. Tracking as currentToolMsg + adding to
  // progressMessages keeps it in the rolling-status chain.
  if (state.currentToolMsg) {
    // TODO(phase-2 delete): bus doesn't own deletions.
    botApi
      .deleteMessage(chatId, state.currentToolMsg.message_id)
      .catch(() => {});
    state.currentToolMsg = null;
  }

  const summary = formatToolResultSummary(
    toolName,
    event.content,
    Boolean(event.isError),
  );
  getMessageBus()
    .send({
      chatId,
      threadId,
      content: summary,
      format: "html",
      silent: true,
    })
    .then((r) => {
      if (!("messageId" in r)) return;
      const stub = busStubMessage(chatId, r.messageId);
      state.currentToolMsg = stub;
      trackProgress(stub);
    })
    .catch((err) => debug(`tail tool_result: ${err}`));
}
