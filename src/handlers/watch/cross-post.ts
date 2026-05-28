/**
 * Cross-surface user-message broadcast: when a session receives input from
 * another surface (terminal, web, cursor), forward a labelled preview into
 * the Telegram topic. The router (`event-router.ts`) handles the inbound TG
 * → bus emit; this handler subscribes for outbound bus → TG forwarding.
 */

import type { Api } from "grammy";
import { getMessageBus } from "../../messaging";
import { globalEventBus, type SessionEventBus } from "../../web/sse";
import type { WatchState } from "./state";

export function setupCrossPostSubscription(
  _botApi: Api,
  watchState: WatchState,
  bus: SessionEventBus = globalEventBus,
): void {
  const { chatId, threadId, sessionName } = watchState;

  const unsub = bus.subscribe(sessionName, (evt) => {
    if (evt.type !== "user_message") return;
    if (evt.source === "telegram") return;
    const prefix =
      evt.source === "web"
        ? "🌐 Web"
        : evt.source === "cursor"
          ? "🖱 Cursor"
          : "🖥 Terminal";
    const preview =
      evt.content.length > 300 ? evt.content.slice(0, 300) + "…" : evt.content;
    getMessageBus()
      .send({
        chatId,
        threadId,
        content: `${prefix}: ${preview}`,
        format: "plain",
      })
      .catch(() => {});
  });

  watchState.unsubCrossPost = unsub;
}
