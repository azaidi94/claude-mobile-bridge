/**
 * /settings command — unified settings panel.
 *
 * Renders one inline-keyboard panel with four edit buttons. Edit flows for
 * enum fields (terminal, model) open sub-keyboards; the text field (working
 * dir) uses a pending-reply pattern handled in text.ts. Auto-watch cycles
 * on→off→default on each tap without a sub-keyboard.
 *
 * Callback routing for `set:*` lives in callback.ts (handleSettingsCallback).
 */

import type { Context } from "grammy";
import { ALLOWED_USERS } from "../config";
import { isAuthorized } from "../security";
import { session } from "../session";
import {
  getTerminal,
  getWorkingDir,
  getAutoWatchOnSpawn,
  getOverrides,
} from "../settings";
import { escapeHtml } from "../formatting";

/**
 * Map of chat IDs awaiting a text reply for a settings field.
 * Consumed by text.ts before its normal routing.
 */
export const pendingSettingsInput = new Map<number, "workdir">();

export const TERMINAL_LABELS: Record<string, string> = {
  terminal: "Terminal.app",
  iterm2: "iTerm2",
  ghostty: "Ghostty",
  cmux: "cmux",
};

function truncPath(p: string, max = 30): string {
  const home = process.env.HOME || "";
  let s = p;
  if (home && s.startsWith(home)) s = "~" + s.slice(home.length);
  if (s.length <= max) return s;
  return "…" + s.slice(-(max - 1));
}

export function renderSettingsBody(): string {
  const terminal = getTerminal();
  const workdir = getWorkingDir();
  const autowatch = getAutoWatchOnSpawn();
  const modelDisplay = session.modelDisplayName;
  const overrides = getOverrides();

  const marker = (k: keyof typeof overrides): string =>
    overrides[k] !== undefined ? "" : " <i>(default)</i>";

  return [
    "⚙️ <b>Settings</b>",
    "",
    "━ Spawning (/new) ━",
    `🖥 Terminal:     <code>${escapeHtml(
      TERMINAL_LABELS[terminal] ?? terminal,
    )}</code>${marker("terminal")}`,
    `📁 Working dir:  <code>${escapeHtml(truncPath(workdir))}</code>${marker(
      "workingDir",
    )}`,
    `👁 Auto-watch:   <code>${autowatch ? "on" : "off"}</code>${marker(
      "autoWatchOnSpawn",
    )}`,
    "",
    "━ Claude defaults ━",
    `🤖 Model:        <code>${escapeHtml(modelDisplay)}</code>${marker(
      "defaultModel",
    )}`,
  ].join("\n");
}

export function renderSettingsKeyboard(): {
  inline_keyboard: { text: string; callback_data: string }[][];
} {
  return {
    inline_keyboard: [
      [
        { text: "🖥 Terminal", callback_data: "set:edit:terminal" },
        { text: "📁 Working dir", callback_data: "set:edit:workdir" },
      ],
      [
        { text: "👁 Auto-watch", callback_data: "set:edit:autowatch" },
        { text: "🤖 Model", callback_data: "set:edit:model" },
      ],
    ],
  };
}

/**
 * /settings — open the panel.
 */
export async function handleSettings(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }
  await ctx.reply(renderSettingsBody(), {
    parse_mode: "HTML",
    reply_markup: renderSettingsKeyboard(),
  });
}

/**
 * Re-render the panel in place (used after edits).
 */
export async function rerenderSettingsPanel(ctx: Context): Promise<void> {
  await ctx
    .editMessageText(renderSettingsBody(), {
      parse_mode: "HTML",
      reply_markup: renderSettingsKeyboard(),
    })
    .catch(() => {
      // Message may be gone; silent.
    });
}
