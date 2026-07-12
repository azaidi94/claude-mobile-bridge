/**
 * Permission-mode banner: emit a one-line "⚙ Plan mode on" / "Auto-accept on" /
 * "Bypass permissions on" Telegram message when the desktop session enters a
 * non-default permission mode. Deduped via `state.lastPermissionMode`; "default"
 * clears the dedup so a later plan→default→plan still notifies.
 */

import type { Api } from "grammy";
import { debug } from "../../logger";
import { getMessageBus } from "../../messaging";
import type { TailEvent } from "../../sessions/tailer";
import type { TailDisplayState } from "./state";

export function renderPermissionMode(
  _botApi: Api,
  state: TailDisplayState,
  event: TailEvent,
  threadId: number | undefined,
): void {
  const mode = event.permissionMode;
  if (!mode) return;
  if (mode === "default") {
    // Reset dedup so a subsequent non-default mode (e.g. plan → default →
    // plan) still notifies. Without this, the second "plan" is silently
    // dropped because lastPermissionMode was never cleared.
    state.lastPermissionMode = undefined;
    return;
  }
  if (state.lastPermissionMode === mode) return; // dedup
  state.lastPermissionMode = mode;
  const labels: Record<string, string> = {
    plan: "Plan mode on",
    acceptEdits: "Auto-accept on",
    bypassPermissions: "Bypass permissions on",
  };
  const label = labels[mode] ?? `${mode} mode`;
  getMessageBus()
    .send({
      chatId: state.chatId,
      threadId,
      content: `⚙ ${label}`,
      format: "plain",
      silent: true,
    })
    .catch((err) =>
      debug("tail permission_mode", {
        err: String(err),
        chatId: state.chatId,
        topic: threadId,
      }),
    );
}
