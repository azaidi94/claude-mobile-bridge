/**
 * Watch handler for live desktop ↔ mobile handoff.
 *
 * /watch [session-name] - Start watching a desktop session in real-time
 * /unwatch - Stop watching
 *
 * While watching, tool calls and text stream to Telegram.
 * Typing a message triggers takeover (resumes session on mobile).
 */

import type { Context } from "grammy";
import type { Api } from "grammy";
import type { Message } from "grammy/types";
import { session } from "../session";
import { ALLOWED_USERS, STREAMING_THROTTLE_MS } from "../config";
import { isAuthorized } from "../security";
import { escapeHtml, convertMarkdownToHtml } from "../formatting";
import {
  SessionTailer,
  findSessionJsonlPath,
  type TailEvent,
} from "../sessions/tailer";
import {
  getActiveSession,
  getSession,
  getSessions,
  setActiveSession,
  updatePinnedStatus,
  getGitBranch,
} from "../sessions";
import { info, debug, warn } from "../logger";
import { TELEGRAM_SAFE_LIMIT } from "../config";

// ============== Watch State ==============

interface WatchState {
  sessionName: string;
  sessionId: string;
  sessionDir: string;
  tailer: SessionTailer;
  chatId: number;
  lastEventTime: number;
  // Display state for streaming
  currentToolMsg: Message | null;
  currentTextMsg: Message | null;
  currentTextContent: string;
  lastTextUpdate: number;
  segmentDone: boolean;
}

// Active watches: chatId -> WatchState
const watches = new Map<number, WatchState>();

/**
 * Check if a chat is currently watching a session.
 */
export function isWatching(chatId: number): boolean {
  return watches.has(chatId);
}

/**
 * Get the watch state for a chat.
 */
export function getWatchState(chatId: number): WatchState | undefined {
  return watches.get(chatId);
}

/**
 * Stop watching for a chat and clean up.
 */
export function stopWatching(chatId: number): WatchState | undefined {
  const state = watches.get(chatId);
  if (state) {
    state.tailer.stop();
    watches.delete(chatId);
    info(`watch: stopped for chat ${chatId}`);
  }
  return state;
}

/**
 * Notify watch handlers that a session went offline.
 * Called from the watcher notification system.
 */
export function notifySessionOffline(botApi: Api, sessionDir: string): void {
  for (const [chatId, state] of watches) {
    if (state.sessionDir === sessionDir) {
      state.tailer.stop();
      watches.delete(chatId);

      // Load session for resume
      const sessionInfo = getSession(state.sessionName);
      if (sessionInfo) {
        session.loadFromRegistry(sessionInfo);
        setActiveSession(state.sessionName);
      }

      botApi
        .sendMessage(
          chatId,
          `📴 <b>${escapeHtml(state.sessionName)}</b> went offline.\nSend a message to continue here.`,
          { parse_mode: "HTML" },
        )
        .catch((err) => warn(`watch offline notify: ${err}`));

      info(
        `watch: session ${state.sessionName} went offline, ready for resume`,
      );
    }
  }
}

/**
 * /watch [session-name] - Start watching a desktop session.
 */
export async function handleWatch(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!userId || !chatId) return;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Already watching?
  if (watches.has(chatId)) {
    const existing = watches.get(chatId)!;
    await ctx.reply(
      `Already watching <b>${escapeHtml(existing.sessionName)}</b>. Use /unwatch first.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  // Parse session name from command
  const text = ctx.message?.text || "";
  const requestedName = text.split(/\s+/)[1];

  // Find the target session
  let targetName: string | null = null;

  if (requestedName) {
    const sessionInfo = getSession(requestedName);
    if (!sessionInfo) {
      await ctx.reply(
        `Session "${escapeHtml(requestedName)}" not found. Use /list.`,
        {
          parse_mode: "HTML",
        },
      );
      return;
    }
    if (sessionInfo.source !== "desktop") {
      await ctx.reply("Can only watch desktop sessions.");
      return;
    }
    targetName = requestedName;
  } else {
    // Try active session, or find first desktop session
    const active = getActiveSession();
    if (active && active.info.source === "desktop") {
      targetName = active.name;
    } else {
      const allSessions = getSessions();
      const desktop = allSessions.find((s) => s.source === "desktop");
      if (desktop) {
        targetName = desktop.name;
      }
    }
  }

  if (!targetName) {
    await ctx.reply(
      "No desktop sessions to watch. Start Claude Code on your desktop first.",
    );
    return;
  }

  const sessionInfo = getSession(targetName)!;

  if (!sessionInfo.id) {
    await ctx.reply("Session has no ID yet. Wait for it to initialize.");
    return;
  }

  // Find the JSONL file
  const jsonlPath = await findSessionJsonlPath(sessionInfo.id);
  if (!jsonlPath) {
    await ctx.reply("Could not find session log file.");
    return;
  }

  // Create watch state
  const watchState: WatchState = {
    sessionName: targetName,
    sessionId: sessionInfo.id,
    sessionDir: sessionInfo.dir,
    tailer: null as unknown as SessionTailer, // set below
    chatId,
    lastEventTime: Date.now(),
    currentToolMsg: null,
    currentTextMsg: null,
    currentTextContent: "",
    lastTextUpdate: 0,
    segmentDone: true,
  };

  // Create tailer with callback bound to this chat
  const botApi = ctx.api;
  const tailer = new SessionTailer(jsonlPath, (event: TailEvent) => {
    handleTailEvent(botApi, chatId, watchState, event);
  });

  watchState.tailer = tailer;
  watches.set(chatId, watchState);

  await tailer.start();

  const dir = sessionInfo.dir.replace(/^\/Users\/[^/]+/, "~");
  await ctx.reply(
    `👁 Watching <b>${escapeHtml(targetName)}</b>\n` +
      `📁 <code>${escapeHtml(dir)}</code>\n\n` +
      `Live events will stream here.\n` +
      `Type a message to take over the session.\n` +
      `Use /unwatch to stop.`,
    { parse_mode: "HTML" },
  );

  // Update pinned status to show watching
  const branch = await getGitBranch(sessionInfo.dir);
  updatePinnedStatus(ctx.api, chatId, {
    sessionName: null,
    isPlanMode: false,
    model: session.modelDisplayName,
    branch,
    isWatching: targetName,
  }).catch(() => {});

  info(`watch: started ${targetName} for chat ${chatId}`);
}

/**
 * /unwatch - Stop watching.
 */
export async function handleUnwatch(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!userId || !chatId) return;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const state = stopWatching(chatId);

  if (state) {
    await ctx.reply(
      `Stopped watching <b>${escapeHtml(state.sessionName)}</b>.`,
      {
        parse_mode: "HTML",
      },
    );

    // Restore normal pinned status
    const active = getActiveSession();
    const branch = await getGitBranch(session.workingDir);
    updatePinnedStatus(ctx.api, chatId, {
      sessionName: active?.name || null,
      isPlanMode: session.isPlanMode,
      model: session.modelDisplayName,
      branch,
    }).catch(() => {});
  } else {
    await ctx.reply("Not currently watching any session.");
  }
}

// ============== Tail Event Display ==============

/**
 * Handle a parsed event from the tailer and display it in Telegram.
 */
function handleTailEvent(
  botApi: Api,
  chatId: number,
  state: WatchState,
  event: TailEvent,
): void {
  state.lastEventTime = Date.now();

  switch (event.type) {
    case "thinking": {
      const preview =
        event.content.length > 300
          ? event.content.slice(0, 300) + "..."
          : event.content;
      botApi
        .sendMessage(chatId, `🧠 <i>${escapeHtml(preview)}</i>`, {
          parse_mode: "HTML",
        })
        .then((msg) => {
          // Track as tool message so it can be cleaned up
          state.currentToolMsg = msg;
        })
        .catch((err) => debug(`watch thinking: ${err}`));
      break;
    }

    case "tool": {
      // Delete previous tool message
      if (state.currentToolMsg) {
        botApi
          .deleteMessage(chatId, state.currentToolMsg.message_id)
          .catch(() => {});
        state.currentToolMsg = null;
      }

      // Finalize any pending text segment
      if (state.currentTextMsg && !state.segmentDone) {
        finalizeTextMessage(botApi, chatId, state);
      }

      botApi
        .sendMessage(chatId, event.content, { parse_mode: "HTML" })
        .then((msg) => {
          state.currentToolMsg = msg;
        })
        .catch((err) => debug(`watch tool: ${err}`));
      break;
    }

    case "text": {
      // Delete tool message when text starts
      if (state.currentToolMsg) {
        botApi
          .deleteMessage(chatId, state.currentToolMsg.message_id)
          .catch(() => {});
        state.currentToolMsg = null;
      }

      state.currentTextContent += event.content;
      state.segmentDone = false;

      const now = Date.now();
      if (now - state.lastTextUpdate < STREAMING_THROTTLE_MS) return;
      state.lastTextUpdate = now;

      const display =
        state.currentTextContent.length > TELEGRAM_SAFE_LIMIT
          ? state.currentTextContent.slice(0, TELEGRAM_SAFE_LIMIT) + "..."
          : state.currentTextContent;
      const formatted = convertMarkdownToHtml(display);

      if (!state.currentTextMsg) {
        // Create new text message
        botApi
          .sendMessage(chatId, formatted, { parse_mode: "HTML" })
          .then((msg) => {
            state.currentTextMsg = msg;
          })
          .catch((err) => {
            debug(`watch text create: ${err}`);
            // Fallback without HTML
            botApi
              .sendMessage(chatId, display)
              .then((msg) => {
                state.currentTextMsg = msg;
              })
              .catch(() => {});
          });
      } else {
        // Edit existing text message
        botApi
          .editMessageText(chatId, state.currentTextMsg.message_id, formatted, {
            parse_mode: "HTML",
          })
          .catch((err) => debug(`watch text edit: ${err}`));
      }
      break;
    }

    case "user": {
      // Desktop user typed something
      // Finalize any pending text
      if (state.currentTextMsg && !state.segmentDone) {
        finalizeTextMessage(botApi, chatId, state);
      }
      // Clean up tool message
      if (state.currentToolMsg) {
        botApi
          .deleteMessage(chatId, state.currentToolMsg.message_id)
          .catch(() => {});
        state.currentToolMsg = null;
      }

      const preview =
        event.content.length > 300
          ? event.content.slice(0, 300) + "..."
          : event.content;
      botApi
        .sendMessage(chatId, `🖥 <b>Desktop:</b> ${escapeHtml(preview)}`, {
          parse_mode: "HTML",
        })
        .catch((err) => debug(`watch user: ${err}`));

      // Reset text state for next response
      state.currentTextMsg = null;
      state.currentTextContent = "";
      state.segmentDone = true;
      break;
    }
  }
}

/**
 * Finalize the current text message with full content.
 */
function finalizeTextMessage(
  botApi: Api,
  chatId: number,
  state: WatchState,
): void {
  if (!state.currentTextMsg || !state.currentTextContent) return;

  const formatted = convertMarkdownToHtml(state.currentTextContent);

  if (formatted.length <= TELEGRAM_SAFE_LIMIT) {
    botApi
      .editMessageText(chatId, state.currentTextMsg.message_id, formatted, {
        parse_mode: "HTML",
      })
      .catch((err) => debug(`watch finalize: ${err}`));
  }

  state.currentTextMsg = null;
  state.currentTextContent = "";
  state.segmentDone = true;
}
