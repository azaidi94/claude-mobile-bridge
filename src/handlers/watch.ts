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
import { info, debug, warn } from "../logger";
import { TELEGRAM_SAFE_LIMIT } from "../config";
import { getRelayClient } from "../relay";
import type { RelayReply } from "../relay/client";
import { sendFile, sendPdfReply } from "../relay/display";

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
  /** When true, tailer should suppress the next relay_reply text (PDF replaces it). */
  suppressRelayReplyText?: boolean;
  /** Cleanup function to remove relay callbacks when watch stops. */
  relayCleanup?: () => void;
}

// Active watches: chatId -> WatchState
const watches = new Map<number, WatchState>();

// Activity-based typing: starts on events, auto-stops after idle
const TYPING_IDLE_MS = 5_000;
const typingState = new Map<
  number,
  { running: boolean; timeout: Timer | null }
>();

/** Signal activity — starts or extends the typing indicator. */
function touchWatchTyping(botApi: Api, chatId: number): void {
  let entry = typingState.get(chatId);
  if (!entry) {
    entry = { running: false, timeout: null };
    typingState.set(chatId, entry);
  }

  // Reset idle timeout
  if (entry.timeout) clearTimeout(entry.timeout);
  entry.timeout = setTimeout(() => stopWatchTyping(chatId), TYPING_IDLE_MS);

  // Start loop if not already running
  if (entry.running) return;
  entry.running = true;
  const loop = async () => {
    while (entry!.running) {
      try {
        await botApi.sendChatAction(chatId, "typing");
      } catch {}
      await Bun.sleep(4000);
    }
  };
  loop();
}

function stopWatchTyping(chatId: number): void {
  const entry = typingState.get(chatId);
  if (entry) {
    entry.running = false;
    if (entry.timeout) clearTimeout(entry.timeout);
    typingState.delete(chatId);
  }
}

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

  const client = await getRelayClient({
    sessionId: state.sessionId,
    sessionDir: state.sessionDir,
    claudePid: state.sessionPid,
  });
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
    state.relayCleanup?.();
    stopWatchTyping(chatId);
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
      stopWatchTyping(chatId);
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

  const started = await startWatchingAndNotify(ctx, chatId, targetName);
  if (!started) {
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

  // Wire relay client for file attachments (tailer only captures text)
  const relayClient = await getRelayClient({
    sessionId: sessionInfo.id,
    sessionDir: sessionInfo.dir,
    claudePid: sessionInfo.pid,
  });
  if (relayClient) {
    const scopeChatId = String(chatId);
    const onReply = (msg: RelayReply) => {
      if (msg.send_as_pdf && msg.text) {
        watchState.suppressRelayReplyText = true;
        sendPdfReply(botApi, chatId, msg.text, msg.pdf_filename);
      }
      if (msg.files?.length) {
        for (const filePath of msg.files) {
          sendFile(botApi, chatId, filePath).catch((err) =>
            warn(`watch file: ${err}`),
          );
        }
      }
    };
    relayClient.onReply(onReply, scopeChatId);
    watchState.relayCleanup = () => relayClient.offReply(onReply);
  }

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
 * Start watching + send the standard notification reply.
 * Returns true if watch started successfully.
 */
export async function startWatchingAndNotify(
  ctx: Context,
  chatId: number,
  sessionName: string,
): Promise<boolean> {
  const watching = await startWatchingSession(ctx.api, chatId, sessionName);
  if (!watching) return false;

  const sessionInfo = getSession(sessionName);
  const dir = (sessionInfo?.dir || "").replace(/^\/Users\/[^/]+/, "~");
  await ctx.reply(
    `👁 Watching <b>${escapeHtml(sessionName)}</b>\n` +
      `📁 <code>${escapeHtml(dir)}</code>\n\n` +
      `Live events will stream here.\n` +
      `Type a message to send via relay.\n` +
      `Use /unwatch to stop.`,
    { parse_mode: "HTML" },
  );
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

  // Typing only during "working" phases — stop when user-visible output arrives
  if (
    event.type === "thinking" ||
    event.type === "tool" ||
    event.type === "user"
  ) {
    touchWatchTyping(botApi, chatId);
  } else {
    stopWatchTyping(chatId);
  }

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

      // Skip sending text if PDF is replacing it
      const ws = state as WatchState;
      if (ws.suppressRelayReplyText) {
        ws.suppressRelayReplyText = false;
      } else {
        const formatted = convertMarkdownToHtml(event.content);
        botApi
          .sendMessage(chatId, formatted, { parse_mode: "HTML" })
          .catch((err) => {
            debug(`tail relay_reply: ${err}`);
            botApi.sendMessage(chatId, event.content).catch(() => {});
          });
      }

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
