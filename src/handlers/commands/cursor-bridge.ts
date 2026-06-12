/**
 * /cursor — Toggle the Cursor AI bridge on or off at runtime.
 *
 * /cursor        — show current status + inline buttons
 * /cursor on     — enable bridge, start syncing live Cursor windows
 * /cursor off    — disable bridge, stop syncing, delete all cursor topics
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { getCursorEnabled, saveSetting } from "../../settings";
import { isAuthorized } from "../../security";
import { getTopicStore } from "../../topics";
import { busReply, getTopicManager } from "./helpers";

function renderCursorText(enabled: boolean): string {
  return (
    `🖱 Cursor AI bridge: <b>${enabled ? "enabled" : "disabled"}</b>\n\n` +
    `• <b>on</b> — bridge active; topics created for live Cursor windows\n` +
    `• <b>off</b> — bridge stopped; all cursor topics removed`
  );
}

function buildCursorKeyboard(enabled: boolean): InlineKeyboard {
  const mark = (active: boolean, label: string) =>
    active ? `✅ ${label}` : label;
  return new InlineKeyboard()
    .text(mark(enabled, "On"), "cursor:on")
    .text(mark(!enabled, "Off"), "cursor:off");
}

async function applyCursorSetting(
  ctx: Context,
  enable: boolean,
): Promise<void> {
  await saveSetting({ cursorEnabled: enable });

  const cursor = await import("../../cursor");
  if (enable) {
    const tm = getTopicManager();
    const chatId = tm?.getChatId();
    cursor.startCursorBridge(
      chatId !== undefined ? { api: ctx.api, chatId } : undefined,
    );
  } else {
    // Delete all cursor-* topics before stopping so the topic store stays clean.
    const tm = getTopicManager();
    if (tm) {
      const cursorTopics = getTopicStore().topics.filter((t) =>
        t.sessionName.startsWith("cursor-"),
      );
      await Promise.allSettled(
        cursorTopics.map((t) => tm.deleteTopic(t.sessionName)),
      );
    }
    cursor.stopCursorBridge();
  }
}

/**
 * /cursor command — show status or apply on|off argument directly.
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

  if (arg === "on" || arg === "off") {
    const enable = arg === "on";
    await applyCursorSetting(ctx, enable);
    await busReply(
      ctx,
      `🖱 Cursor AI bridge: <b>${enable ? "enabled" : "disabled"}</b>.`,
      "html",
    );
    return;
  }

  if (arg) {
    await busReply(ctx, "❌ Usage: /cursor [on|off]");
    return;
  }

  const enabled = getCursorEnabled();
  await busReply(ctx, renderCursorText(enabled), {
    format: "html",
    replyMarkup: buildCursorKeyboard(enabled),
  });
}

/**
 * Callback handler for cursor:<on|off> inline buttons.
 */
export async function handleCursorBridgeCallback(
  ctx: Context,
  action: string,
): Promise<void> {
  if (action !== "on" && action !== "off") {
    await ctx.answerCallbackQuery({ text: "Unknown action" });
    return;
  }
  const enable = action === "on";
  await applyCursorSetting(ctx, enable);
  try {
    await ctx.editMessageText(renderCursorText(enable), {
      parse_mode: "HTML",
      reply_markup: buildCursorKeyboard(enable),
    });
  } catch {
    // Message too old to edit — ignore.
  }
  await ctx.answerCallbackQuery({
    text: `Cursor AI bridge ${enable ? "enabled" : "disabled"}.`,
  });
}
