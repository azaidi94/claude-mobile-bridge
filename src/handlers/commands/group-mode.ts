/**
 * /groupmode - Toggle bot routing between supergroup topics and private DM.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { getGroupModeSetting, saveSetting } from "../../settings";
import { isAuthorized } from "../../security";
import { busReply } from "./helpers";

type GroupModeAction = "on" | "off" | "auto";

function parseGroupModeAction(arg: string): GroupModeAction | null {
  if (arg === "on" || arg === "group") return "on";
  if (arg === "off" || arg === "private") return "off";
  if (arg === "auto") return "auto";
  return null;
}

function groupModeActionToSetting(
  action: GroupModeAction,
): boolean | undefined {
  if (action === "on") return true;
  if (action === "off") return false;
  return undefined;
}

function groupModeLabel(value: boolean | undefined): string {
  if (value === undefined) return "auto";
  return value ? "group" : "private";
}

function renderGroupModeText(current: boolean | undefined): string {
  return (
    `⚙️ Group mode: <b>${groupModeLabel(current)}</b>\n\n` +
    `• <b>group</b> — supergroup topics (DMs blocked)\n` +
    `• <b>private</b> — DM only (group blocked)\n` +
    `• <b>auto</b> — follow forum-group detection\n\n` +
    `Pick a mode. Takes effect after /restart.`
  );
}

function buildGroupModeKeyboard(current: boolean | undefined): InlineKeyboard {
  const mark = (active: boolean, label: string) =>
    active ? `✅ ${label}` : label;
  return new InlineKeyboard()
    .text(mark(current === true, "Group"), "gm:on")
    .text(mark(current === false, "Private"), "gm:off")
    .text(mark(current === undefined, "Auto"), "gm:auto");
}

/**
 * /groupmode - Toggle routing between supergroup topics and private DM.
 * Shows inline buttons; also accepts on|off|auto as a text arg.
 */
export async function handleGroupMode(ctx: Context): Promise<void> {
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

  if (arg) {
    const action = parseGroupModeAction(arg);
    if (!action) {
      await busReply(ctx, "❌ Usage: /groupmode [on|off|auto]");
      return;
    }
    const next = groupModeActionToSetting(action);
    await saveSetting({ groupMode: next });
    await busReply(
      ctx,
      `✅ Group mode: <b>${groupModeLabel(next)}</b>. /restart to apply.`,
      "html",
    );
    return;
  }

  const current = getGroupModeSetting();
  await busReply(ctx, renderGroupModeText(current), {
    format: "html",
    replyMarkup: buildGroupModeKeyboard(current),
  });
}

/** Callback handler for gm:<on|off|auto> — updates the setting and re-renders. */
export async function handleGroupModeCallback(
  ctx: Context,
  action: string,
): Promise<void> {
  const parsed = parseGroupModeAction(action);
  if (!parsed) {
    await ctx.answerCallbackQuery({ text: "Unknown action" });
    return;
  }
  const next = groupModeActionToSetting(parsed);
  await saveSetting({ groupMode: next });
  try {
    await ctx.editMessageText(renderGroupModeText(next), {
      parse_mode: "HTML",
      reply_markup: buildGroupModeKeyboard(next),
    });
  } catch {
    // If the message can't be edited (too old), ignore.
  }
  await ctx.answerCallbackQuery({
    text: `Set to ${groupModeLabel(next)}. /restart to apply.`,
  });
}
