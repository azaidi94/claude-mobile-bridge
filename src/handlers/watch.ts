/**
 * Watch handler for live desktop ↔ mobile handoff.
 *
 * /watch [session-name] - Start watching a desktop session in real-time
 * /unwatch - Stop watching
 *
 * While watching, tool calls and text stream to Telegram.
 * Typing a message sends via relay (or falls back to takeover if no relay).
 */

import type { Context, Api } from "grammy";
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
import { homedir } from "os";
import { info, debug, warn } from "../logger";
import { TELEGRAM_SAFE_LIMIT } from "../config";
import { getRelayClient } from "../relay";

// ============== Shared Tail Display State ==============

/** Common display state used by both /watch and relay display pipelines. */
export interface TailDisplayState {
  chatId: number;
  currentToolMsg: Message | null;
  currentTextMsg: Message | null;
  currentTextContent: string;
  lastTextUpdate: number;
  segmentDone: boolean;
  /** Optional: track messages for bulk cleanup (used by relay). */
  progressMessages?: Message[];
  /** Optional: stop showing progress after final reply (used by relay). */
  finalReplyReceived?: boolean;
}

// ============== Watch State ==============

interface WatchState extends TailDisplayState {
  sessionName: string;
  sessionId: string;
  sessionDir: string;
  sessionPid?: number;
  tailer: SessionTailer;
  lastEventTime: number;
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
 * Send a message via relay while watching (no takeover).
 * Returns true if relay was used.
 */
export async function sendWatchRelay(
  chatId: number,
  username: string,
  text: string,
): Promise<boolean> {
  const state = watches.get(chatId);
  if (!state) return false;

  const client = await getRelayClient(state.sessionDir, state.sessionPid);
  if (!client) return false;

  client.sendMessage({
    chat_id: String(chatId),
    user: username,
    text,
  });
  return true;
}

/**
 * Stop watching for a chat and clean up.
 * If botApi is provided, flushes any pending text message before stopping.
 */
export function stopWatching(
  chatId: number,
  botApi?: Api,
): WatchState | undefined {
  const state = watches.get(chatId);
  if (state) {
    // Flush pending text before stopping
    if (botApi && state.currentTextMsg && !state.segmentDone) {
      finalizeTextMessage(botApi, state);
    }
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

  // Don't start watching while a query is running
  if (session.isRunning) {
    await ctx.reply("A query is in progress. Use /stop first.");
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

  const started = await startWatchingSession(ctx.api, chatId, targetName);
  if (started) {
    const sessionInfo = getSession(targetName)!;
    const home = homedir();
    const dir = sessionInfo.dir.startsWith(home)
      ? "~" + sessionInfo.dir.slice(home.length)
      : sessionInfo.dir;
    await ctx.reply(
      `👁 Watching <b>${escapeHtml(targetName)}</b>\n` +
        `📁 <code>${escapeHtml(dir)}</code>\n\n` +
        `Live events will stream here.\n` +
        `Type a message to send via relay.\n` +
        `Use /unwatch to stop.`,
      { parse_mode: "HTML" },
    );
  } else {
    await ctx.reply("Could not start watching (no session ID or log file).");
  }
}

/**
 * Start watching a session by name. Returns true on success.
 * Used by /watch command and auto-watch on /switch.
 */
export async function startWatchingSession(
  botApi: Api,
  chatId: number,
  targetName: string,
): Promise<boolean> {
  // Stop existing watch if any
  if (watches.has(chatId)) {
    stopWatching(chatId, botApi);
  }

  const sessionInfo = getSession(targetName);
  if (!sessionInfo?.id) return false;

  const jsonlPath = await findSessionJsonlPath(sessionInfo.id);
  if (!jsonlPath) return false;

  const tailer = new SessionTailer(jsonlPath, (event: TailEvent) => {
    handleTailEvent(botApi, watchState, event);
  });
  const watchState: WatchState = {
    sessionName: targetName,
    sessionId: sessionInfo.id,
    sessionDir: sessionInfo.dir,
    sessionPid: sessionInfo.pid,
    tailer,
    chatId,
    lastEventTime: Date.now(),
    currentToolMsg: null,
    currentTextMsg: null,
    currentTextContent: "",
    lastTextUpdate: 0,
    segmentDone: true,
  };
  watches.set(chatId, watchState);
  await tailer.start();

  const branch = await getGitBranch(sessionInfo.dir);
  updatePinnedStatus(botApi, chatId, {
    sessionName: null,
    isPlanMode: false,
    model: session.modelDisplayName,
    branch,
    isWatching: targetName,
  }).catch(() => {});

  info(`watch: started ${targetName} for chat ${chatId}`);
  return true;
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

  const state = stopWatching(chatId, ctx.api);

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
 * Handle a parsed tail event and display it in Telegram.
 * Shared by both /watch and relay display pipelines.
 */
export function handleTailEvent(
  botApi: Api,
  state: TailDisplayState,
  event: TailEvent,
): void {
  if (state.finalReplyReceived) return;

  const { chatId } = state;
  const trackProgress = (msg: Message) => {
    state.progressMessages?.push(msg);
  };

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
          state.currentToolMsg = msg;
          trackProgress(msg);
        })
        .catch((err) => debug(`tail thinking: ${err}`));
      break;
    }

    case "tool": {
      if (state.currentToolMsg) {
        botApi
          .deleteMessage(chatId, state.currentToolMsg.message_id)
          .catch(() => {});
        state.currentToolMsg = null;
      }
      if (state.currentTextMsg && !state.segmentDone) {
        finalizeTextMessage(botApi, state);
      }

      botApi
        .sendMessage(chatId, event.content, { parse_mode: "HTML" })
        .then((msg) => {
          state.currentToolMsg = msg;
          trackProgress(msg);
        })
        .catch((err) => debug(`tail tool: ${err}`));
      break;
    }

    case "text": {
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
        botApi
          .sendMessage(chatId, formatted, { parse_mode: "HTML" })
          .then((msg) => {
            state.currentTextMsg = msg;
            trackProgress(msg);
          })
          .catch((err) => {
            debug(`tail text create: ${err}`);
            botApi
              .sendMessage(chatId, display)
              .then((msg) => {
                state.currentTextMsg = msg;
                trackProgress(msg);
              })
              .catch(() => {});
          });
      } else {
        botApi
          .editMessageText(chatId, state.currentTextMsg.message_id, formatted, {
            parse_mode: "HTML",
          })
          .catch((err) => debug(`tail text edit: ${err}`));
      }
      break;
    }

    case "relay_reply": {
      if (state.currentToolMsg) {
        botApi
          .deleteMessage(chatId, state.currentToolMsg.message_id)
          .catch(() => {});
        state.currentToolMsg = null;
      }
      if (state.currentTextMsg && !state.segmentDone) {
        finalizeTextMessage(botApi, state);
      }

      const formatted = convertMarkdownToHtml(event.content);
      botApi
        .sendMessage(chatId, formatted, { parse_mode: "HTML" })
        .catch((err) => {
          debug(`tail relay_reply: ${err}`);
          botApi.sendMessage(chatId, event.content).catch(() => {});
        });

      state.currentTextMsg = null;
      state.currentTextContent = "";
      state.segmentDone = true;
      break;
    }

    case "user": {
      if (state.currentTextMsg && !state.segmentDone) {
        finalizeTextMessage(botApi, state);
      }
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
        .catch((err) => debug(`tail user: ${err}`));

      state.currentTextMsg = null;
      state.currentTextContent = "";
      state.segmentDone = true;
      break;
    }
  }
}

export function finalizeTextMessage(
  botApi: Api,
  state: TailDisplayState,
): void {
  if (!state.currentTextMsg || !state.currentTextContent) return;

  const formatted = convertMarkdownToHtml(state.currentTextContent);
  if (formatted.length <= TELEGRAM_SAFE_LIMIT) {
    botApi
      .editMessageText(
        state.chatId,
        state.currentTextMsg.message_id,
        formatted,
        { parse_mode: "HTML" },
      )
      .catch((err) => debug(`tail finalize: ${err}`));
  }

  state.currentTextMsg = null;
  state.currentTextContent = "";
  state.segmentDone = true;
}
