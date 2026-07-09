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
import { getCurrentModelDisplayName } from "../session";
import {
  getTerminal,
  getWorkingDir,
  getAutoWatchOnSpawn,
  getEnablePinnedStatus,
  getWatchImages,
  getContextNotifyStep,
  getRalphVerboseDefault,
  getDefaultRalphLabel,
  getVerboseLevel,
  getOverrides,
} from "../settings";
import { escapeHtml } from "../formatting";
import { getMessageBus } from "../messaging";

/**
 * Map of chat IDs awaiting a text reply for a settings field.
 * Consumed by text.ts before its normal routing.
 */
export const pendingSettingsInput = new Map<string, "workdir" | "ralphlabel">(); // pendingKey -> field

export const TERMINAL_LABELS: Record<string, string> = {
  terminal: "Terminal.app",
  iterm2: "iTerm2",
  ghostty: "Ghostty",
  cmux: "cmux",
};

/** Short labels for the verbosity level, shown in the panel and toast. */
export const VERBOSE_LABELS: Record<0 | 1 | 2, string> = {
  0: "quiet",
  1: "normal",
  2: "detailed",
};

function formatNotifyStep(n: number): string {
  return n === 0 ? "off" : `every ${n}%`;
}

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
  const pinnedStatus = getEnablePinnedStatus();
  const watchImages = getWatchImages();
  const ralphVerbose = getRalphVerboseDefault();
  const ralphLabel = getDefaultRalphLabel();
  const modelDisplay = getCurrentModelDisplayName();
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
    "",
    "━ Features ━",
    `📌 Pinned Status: <code>${pinnedStatus ? "on" : "off"}</code>${marker(
      "enablePinnedStatus",
    )}`,
    `🖼 Images:        <code>${watchImages ? "on" : "off"}</code>${marker(
      "watchImages",
    )}`,
    `🔊 Verbosity:     <code>${VERBOSE_LABELS[getVerboseLevel()]}</code>${marker(
      "verboseLevel",
    )}`,
    `🔁 Ralph verbose: <code>${ralphVerbose ? "on" : "off"}</code>${marker(
      "ralphVerboseDefault",
    )}`,
    `🏷 Ralph label:   <code>${
      ralphLabel ? escapeHtml(ralphLabel) : "all issues"
    }</code>${marker("defaultRalphLabel")}`,
    "",
    "━ Notifications ━",
    `🧠 Context notify: <code>${formatNotifyStep(
      getContextNotifyStep(),
    )}</code>${marker("contextNotifyStep")}`,
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
      [
        { text: "📌 Pinned Status", callback_data: "set:edit:pinnedstatus" },
        { text: "🖼 Images", callback_data: "set:edit:images" },
      ],
      [{ text: "🔊 Verbosity", callback_data: "set:edit:verbose" }],
      [
        { text: "🔁 Ralph verbose", callback_data: "set:edit:ralphverbose" },
        { text: "🏷 Ralph label", callback_data: "set:edit:ralphlabel" },
      ],
      [{ text: "🧠 Context notify", callback_data: "set:edit:contextnotify" }],
    ],
  };
}

/**
 * /settings — open the panel.
 */
export async function handleSettings(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    if (chatId !== undefined) {
      await getMessageBus().send({
        chatId,
        threadId: ctx.message?.message_thread_id,
        content: "Unauthorized.",
        format: "plain",
      });
    }
    return;
  }
  if (chatId !== undefined) {
    await getMessageBus().send({
      chatId,
      threadId: ctx.message?.message_thread_id,
      content: renderSettingsBody(),
      format: "html",
      replyMarkup: renderSettingsKeyboard(),
    });
  }
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
