/**
 * /cursor — list live Cursor sessions and pick which one forwards to Telegram.
 *
 * /cursor        — start the bridge if needed, then show the cursor-session
 *                  list with a subscribe button per session.
 * /cursor on     — alias for /cursor (ensure bridge running + show list).
 * /cursor off    — unwatch all: clear the subscription, delete every cursor
 *                  topic, and stop the bridge. Nothing forwards until /cursor
 *                  is run again and a session is picked.
 *
 * Subscription is single: tapping a session (cursorsub:<name>) makes it the
 * sole forwarded session and unwires the previous one. The choice persists to
 * settings.json so it re-wires on restart once the window re-attaches.
 */

import type { Context } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { ALLOWED_USERS } from "../../config";
import { saveSetting, getCursorSubscribedSession } from "../../settings";
import { isAuthorized } from "../../security";
import { getSessions, getSession } from "../../sessions";
import { getTopicStore, getTopicBySession } from "../../topics";
import { getMessageBus } from "../../messaging";
import { busReply, getTopicManager } from "./helpers";

/**
 * Build the cursor-session list view (text + inline keyboard). Lists only
 * sessions with `source === "cursor"`, marks the subscribed one, and offers a
 * deep-link to its topic plus an Off button.
 */
async function buildCursorListView(): Promise<{
  text: string;
  keyboard: InlineKeyboardMarkup;
}> {
  const cursor = await import("../../cursor");
  const subscribed = cursor.getCursorSubscription();
  const sessions = getSessions().filter((s) => s.source === "cursor");

  if (sessions.length === 0) {
    return {
      text:
        "🖱 <b>Cursor sessions</b>\n\n" +
        "No live Cursor windows detected yet. Open a workspace in Cursor, " +
        "then re-run /cursor.",
      keyboard: {
        inline_keyboard: [
          [{ text: "🔕 Off (stop bridge)", callback_data: "cursor:off" }],
        ],
      },
    };
  }

  // Tiny title + one button per session (✅ marks the subscribed one). No
  // per-session meta text — the buttons are the selector.
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (const s of sessions) {
    const isSub = s.name === subscribed;
    rows.push([
      {
        text: isSub ? `✅ ${s.name}` : s.name,
        callback_data: `cursorsub:${s.name}`,
      },
    ]);
  }

  // Deep-link to the subscribed session's topic so the user can jump straight
  // to it. Supergroup deep links drop the -100 chat-id prefix.
  const store = getTopicStore();
  if (subscribed && store.chatId) {
    const topic = getTopicBySession(subscribed);
    if (topic) {
      const internal = String(store.chatId).replace(/^-100/, "");
      rows.push([
        {
          text: `➡ Open ${subscribed}`,
          url: `https://t.me/c/${internal}/${topic.topicId}`,
        },
      ]);
    }
  }

  rows.push([{ text: "🔕 Off (unwatch all)", callback_data: "cursor:off" }]);

  return { text: "🖱 <b>Cursor</b>", keyboard: { inline_keyboard: rows } };
}

/**
 * Ensure the bridge is polling and the persisted subscription is restored.
 * Idempotent — startCursorBridge no-ops when already running.
 */
async function ensureBridgeRunning(ctx: Context): Promise<void> {
  const cursor = await import("../../cursor");
  if (cursor.isCursorBridgeRunning()) return;

  const tm = getTopicManager();
  const chatId = tm?.getChatId();
  cursor.startCursorBridge(
    chatId !== undefined ? { api: ctx.api, chatId } : undefined,
  );
  // Re-wire the persisted choice so forwarding resumes once the window attaches.
  cursor.setCursorSubscription(getCursorSubscribedSession() ?? null);
  await saveSetting({ cursorEnabled: true });
}

/** Tear everything down: clear subscription, delete cursor topics, stop bridge. */
async function applyCursorOff(): Promise<void> {
  await saveSetting({
    cursorEnabled: false,
    cursorSubscribedSession: undefined,
  });

  const tm = getTopicManager();
  if (tm) {
    const cursorTopics = getTopicStore().topics.filter((t) =>
      t.sessionName.startsWith("cursor-"),
    );
    await Promise.allSettled(
      cursorTopics.map((t) => tm.deleteTopic(t.sessionName)),
    );
  }

  const cursor = await import("../../cursor");
  cursor.stopCursorBridge();
}

/**
 * /cursor command — show the cursor-session list, or `off` to tear down.
 */
export async function handleCursorBridge(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  const arg = (ctx.message?.text || "")
    .split(/\s+/)
    .slice(1)
    .join(" ")
    .trim()
    .toLowerCase();

  if (arg === "off") {
    await applyCursorOff();
    await busReply(
      ctx,
      "🔕 Cursor bridge stopped — all cursor topics removed. Run /cursor to pick a session again.",
    );
    return;
  }

  if (arg && arg !== "on") {
    await busReply(ctx, "❌ Usage: /cursor [on|off]");
    return;
  }

  // No arg or "on": ensure the bridge is up, scan windows, then list.
  await ensureBridgeRunning(ctx);
  const cursor = await import("../../cursor");
  await cursor.refreshCursorTargets();

  const { text, keyboard } = await buildCursorListView();
  await busReply(ctx, text, { format: "html", replyMarkup: keyboard });
}

/**
 * cursorsub:<name> — subscribe (forward to Telegram) a single Cursor session.
 */
export async function handleCursorSubscribe(
  ctx: Context,
  sessionName: string,
): Promise<void> {
  const session = getSession(sessionName);
  if (!session || session.source !== "cursor") {
    await ctx.answerCallbackQuery({ text: "Session not found" });
    return;
  }

  // Cursor topics are created on demand (not on window-attach). Create this
  // session's topic now if it doesn't exist, so cross-post has somewhere to
  // forward and the deep-link resolves.
  const tm = getTopicManager();
  if (tm && !getTopicBySession(sessionName)) {
    await tm.createTopic(session.name, session.dir, session.id).catch(() => {});
  }

  const cursor = await import("../../cursor");
  cursor.setCursorSubscription(sessionName);
  await saveSetting({ cursorSubscribedSession: sessionName });

  // Bump the session's topic so it surfaces in the forum list, confirming the
  // subscription in-place.
  const store = getTopicStore();
  const topic = getTopicBySession(sessionName);
  if (topic && store.chatId) {
    void getMessageBus()
      .send({
        chatId: store.chatId,
        threadId: topic.topicId,
        content: "🔔 Telegram is now watching this Cursor session.",
        format: "plain",
      })
      .catch(() => {});
  }

  // Refresh the list message in place with the updated ✅ marker.
  try {
    const { text, keyboard } = await buildCursorListView();
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } catch {
    // Message too old to edit — ignore.
  }
  await ctx.answerCallbackQuery({ text: `Watching ${sessionName}` });
}

/**
 * Callback handler for the `cursor:<action>` inline buttons. Only `off` (the
 * teardown button on the list) is handled here — subscription taps use the
 * `cursorsub:` prefix routed to handleCursorSubscribe.
 */
export async function handleCursorBridgeCallback(
  ctx: Context,
  action: string,
): Promise<void> {
  if (action !== "off") {
    await ctx.answerCallbackQuery({ text: "Unknown action" });
    return;
  }
  await applyCursorOff();
  try {
    await ctx.editMessageText(
      "🔕 Cursor bridge stopped — all cursor topics removed. Run /cursor to pick a session again.",
    );
  } catch {
    // Message too old to edit — ignore.
  }
  await ctx.answerCallbackQuery({ text: "Cursor bridge stopped." });
}
