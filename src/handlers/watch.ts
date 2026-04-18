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
import type { SessionOverride } from "../sessions/types";
import { session } from "../session";
import { ALLOWED_USERS, STREAMING_THROTTLE_MS } from "../config";
import { isAuthorized } from "../security";
import { escapeHtml, convertMarkdownToHtml } from "../formatting";
import {
  SessionTailer,
  findSessionJsonlPath,
  findNewestSessionInDir,
  getExpectedJsonlPath,
  type TailEvent,
} from "../sessions/tailer";
import {
  getActiveSession,
  getSession,
  getSessions,
  setActiveSession,
  updatePinnedStatus,
  getGitBranch,
  forceRefresh,
} from "../sessions";
import { info, debug, warn, elapsedMs } from "../logger";
import { TELEGRAM_SAFE_LIMIT } from "../config";
import { getRelayClient } from "../relay";
import type { RelayReply } from "../relay/client";
import { sendFile, sendPdfReply, sendTextReply } from "../relay/display";
import { getRecentHistory } from "../sessions/history";

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
  /** Topic thread ID — all messages go to this thread. */
  threadId: number;
  /** When true, tailer should suppress the next relay_reply text (PDF replaces it). */
  suppressRelayReplyText?: boolean;
  /** Cleanup function to remove relay callbacks when watch stops. */
  relayCleanup?: () => void;
  /** Interval that detects when the desktop session starts a new conversation. */
  idCheckInterval?: Timer;
  /**
   * Spawn-initiated watches seed `sessionId` with the most-recent JSONL
   * fallback (watcher.ts:347), because the freshly-launched claude process
   * hasn't written its real JSONL yet. The first id-change in
   * `idCheckInterval` is therefore the arrival of the real id, not a
   * genuine conversation switch — suppress the "reconnected" broadcast
   * once, then resume normal behavior.
   */
  suppressNextIdChangeNotice?: boolean;
}

// Active watches: "chatId:threadId" -> WatchState
type WatchKey = `${number}:${number}`;
const watches = new Map<WatchKey, WatchState>();

// Recently-killed session ids. A sibling sharing the dir could otherwise
// drift onto the dying session's JSONL (still the newest for a moment).
const KILLED_ID_TTL_MS = 120_000;
const killedSessionIds = new Map<string, Timer>();

function blacklistKilledSessionId(sessionId: string): void {
  if (!sessionId) return;
  const existing = killedSessionIds.get(sessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(
    () => killedSessionIds.delete(sessionId),
    KILLED_ID_TTL_MS,
  );
  killedSessionIds.set(sessionId, timer);
}

function watchKey(chatId: number, threadId: number): WatchKey {
  return `${chatId}:${threadId}`;
}

function watchKeyChatPrefix(chatId: number): string {
  return `${chatId}:`;
}

function buildWatchState(args: {
  sessionName: string;
  sessionId: string;
  sessionDir: string;
  sessionPid?: number;
  tailer: SessionTailer;
  chatId: number;
  threadId: number;
  suppressNextIdChangeNotice?: boolean;
}): WatchState {
  return {
    sessionName: args.sessionName,
    sessionId: args.sessionId,
    sessionDir: args.sessionDir,
    sessionPid: args.sessionPid,
    tailer: args.tailer,
    chatId: args.chatId,
    threadId: args.threadId,
    lastEventTime: Date.now(),
    currentToolMsg: null,
    currentTextMsg: null,
    currentTextContent: "",
    lastTextUpdate: 0,
    segmentDone: true,
    ...(args.suppressNextIdChangeNotice
      ? { suppressNextIdChangeNotice: true }
      : {}),
  };
}

// Activity-based typing: starts on events, auto-stops after idle
const TYPING_IDLE_MS = 5_000;
const typingState = new Map<
  WatchKey,
  { running: boolean; timeout: Timer | null }
>();

/** Signal activity — starts or extends the typing indicator. */
function touchWatchTyping(botApi: Api, chatId: number, threadId: number): void {
  const key = watchKey(chatId, threadId);
  let entry = typingState.get(key);
  if (!entry) {
    entry = { running: false, timeout: null };
    typingState.set(key, entry);
  }

  // Reset idle timeout
  if (entry.timeout) clearTimeout(entry.timeout);
  entry.timeout = setTimeout(
    () => stopWatchTyping(chatId, threadId),
    TYPING_IDLE_MS,
  );

  // Start loop if not already running
  if (entry.running) return;
  entry.running = true;
  const loop = async () => {
    while (entry!.running) {
      try {
        await botApi.sendChatAction(chatId, "typing", {
          message_thread_id: threadId,
        });
      } catch {}
      await Bun.sleep(4000);
    }
  };
  loop();
}

function stopWatchTyping(chatId: number, threadId: number): void {
  const key = watchKey(chatId, threadId);
  const entry = typingState.get(key);
  if (entry) {
    entry.running = false;
    if (entry.timeout) clearTimeout(entry.timeout);
    typingState.delete(key);
  }
}

/**
 * Check if a specific (chatId, threadId) pair is currently watching.
 * Callers in General chat with no thread should use isWatchingAny instead.
 */
export function isWatching(chatId: number, threadId: number): boolean {
  return watches.has(watchKey(chatId, threadId));
}

/** True if any topic in this chat has an active watch. */
export function isWatchingAny(chatId: number): boolean {
  const prefix = watchKeyChatPrefix(chatId);
  for (const k of watches.keys()) {
    if (k.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Send a message via relay while watching (no takeover).
 * Returns true if relay was used.
 */
export async function sendWatchRelay(
  chatId: number,
  threadId: number,
  username: string,
  text: string,
  opId?: string,
  imagePath?: string,
  /** Override session target (for topic mode where watch may point at a different session). */
  sessionOverride?: SessionOverride,
): Promise<boolean> {
  const state = watches.get(watchKey(chatId, threadId));
  if (!state) return false;
  const startedAt = Date.now();

  const target = sessionOverride || state;
  const client = await getRelayClient({
    sessionId: target.sessionId,
    sessionDir: target.sessionDir,
    claudePid: target.sessionPid,
  });
  if (!client) return false;

  client.sendMessage({
    chat_id: String(chatId),
    user: username,
    text,
    ...(imagePath ? { image_path: imagePath } : {}),
  });
  info("watch: relay queued", {
    opId,
    chatId,
    threadId,
    sessionName: state.sessionName,
    sessionId: state.sessionId,
    sessionDir: state.sessionDir,
    durationMs: elapsedMs(startedAt),
  });
  return true;
}

/** Stop tailer, relay callbacks, typing indicator; remove from watches map. */
function cleanupWatch(state: WatchState): void {
  state.tailer.stop();
  state.relayCleanup?.();
  if (state.idCheckInterval) clearInterval(state.idCheckInterval);
  stopWatchTyping(state.chatId, state.threadId);
  watches.delete(watchKey(state.chatId, state.threadId));
}

export function stopWatching(
  chatId: number,
  threadId: number,
  botApi?: Api,
  reason = "manual",
): WatchState | undefined {
  const state = watches.get(watchKey(chatId, threadId));
  if (state) {
    // Flush pending text before stopping
    if (botApi && state.currentTextMsg && !state.segmentDone) {
      finalizeTextMessage(botApi, state);
    }
    cleanupWatch(state);
    info("watch: stopped", {
      chatId,
      threadId,
      sessionName: state.sessionName,
      sessionId: state.sessionId,
      sessionDir: state.sessionDir,
      reason,
    });
  }
  return state;
}

/**
 * Stop watching the session whose sessionName matches `sessionName`.
 * Used by killSession so only the killed session's watch is stopped,
 * leaving other topics' watches intact — including sibling sessions that
 * share a sessionDir.
 */
export function stopWatchByName(
  sessionName: string,
  botApi?: Api,
  reason = "byName",
): WatchState | undefined {
  for (const [, state] of watches) {
    if (state.sessionName === sessionName) {
      if (botApi && state.currentTextMsg && !state.segmentDone) {
        finalizeTextMessage(botApi, state);
      }
      if (reason === "kill") blacklistKilledSessionId(state.sessionId);
      cleanupWatch(state);
      info("watch: stopped by name", {
        chatId: state.chatId,
        threadId: state.threadId,
        sessionName,
        sessionDir: state.sessionDir,
        reason,
      });
      return state;
    }
  }
  return undefined;
}

/**
 * Notify watch handlers that a session went offline.
 * Called from the watcher notification system.
 */
export function notifySessionOffline(botApi: Api, sessionName: string): void {
  for (const [, state] of watches) {
    if (state.sessionName !== sessionName) continue;
    const { chatId, threadId } = state;
    cleanupWatch(state);

    const sessionInfo = getSession(state.sessionName);
    if (sessionInfo) {
      session.loadFromRegistry(sessionInfo);
      setActiveSession(state.sessionName);
    }

    botApi
      .sendMessage(
        chatId,
        `📴 <b>${escapeHtml(state.sessionName)}</b> went offline.\nSend a message to continue here.`,
        { parse_mode: "HTML", message_thread_id: threadId },
      )
      .catch((err) => warn(`watch offline notify: ${err}`));

    warn("watch: session went offline", {
      chatId,
      threadId,
      sessionName: state.sessionName,
      sessionId: state.sessionId,
      sessionDir: state.sessionDir,
      readyForResume: Boolean(sessionInfo),
    });
    return;
  }
}

// ============== Auto-Watch (topic mode) ==============

/**
 * Poll for new-conversation detection: when the desktop session starts a new
 * conversation (new JSONL, same dir), restart the tailer against the new file.
 * /clear doesn't rewrite the relay port file, so without this the tailer stays
 * stuck on the stale pre-/clear JSONL while relay messages still flow.
 */
function setupIdDriftDetection(botApi: Api, watchState: WatchState): void {
  const { chatId, threadId, sessionName } = watchState;
  watchState.idCheckInterval = setInterval(async () => {
    if (!watches.has(watchKey(chatId, threadId))) return;
    // Only drift when sole owner of the dir. With siblings, the newest
    // JSONL can't be attributed to a specific named session, and toggling
    // sessionId on each mode change would fire spurious "🔄" notices and
    // revert /clear recovery earned while solo.
    for (const other of watches.values()) {
      if (other === watchState) continue;
      if (other.sessionDir === watchState.sessionDir) return;
    }
    const excludeIds =
      killedSessionIds.size > 0
        ? new Set<string>(killedSessionIds.keys())
        : undefined;
    const newestJsonl = await findNewestSessionInDir(
      watchState.sessionDir,
      excludeIds,
    );
    const newId = newestJsonl ?? getSession(sessionName)?.id;

    if (!newId || newId === watchState.sessionId) return;
    if (killedSessionIds.has(newId)) return;
    // Defense in depth: don't steal an id another live watcher already holds.
    for (const other of watches.values()) {
      if (other === watchState) continue;
      if (other.sessionDir !== watchState.sessionDir) continue;
      if (other.sessionId === newId) return;
    }
    // Claim synchronously so a concurrent drift tick on a sibling watch sees
    // this id as taken before its own guard runs.
    const previousId = watchState.sessionId;
    watchState.sessionId = newId;
    const newPath = await findSessionJsonlPath(newId);
    if (!newPath) {
      watchState.sessionId = previousId;
      return;
    }
    watchState.tailer?.stop();
    const newTailer = new SessionTailer(newPath, (event: TailEvent) =>
      handleTailEvent(botApi, watchState, event, watchState.threadId),
    );
    watchState.tailer = newTailer;
    await newTailer.start();
    const wasSpawnSeed = watchState.suppressNextIdChangeNotice === true;
    watchState.suppressNextIdChangeNotice = false;
    info("watch: restarted tailer for new conversation", {
      chatId,
      sessionName,
      sessionId: newId,
      suppressedNotice: wasSpawnSeed,
    });
    if (wasSpawnSeed) return;
    botApi
      .sendMessage(
        chatId,
        `🔄 <b>${escapeHtml(sessionName)}</b> started a new conversation.`,
        { parse_mode: "HTML", message_thread_id: watchState.threadId },
      )
      .catch(() => {});
  }, 5_000);
}

/**
 * Start auto-watching a session in a topic.
 * Called by topic manager when a topic is created and session is online.
 */
export async function startAutoWatch(
  botApi: Api,
  chatId: number,
  threadId: number,
  sessionName: string,
): Promise<boolean> {
  // Stop existing watch for THIS (chatId, threadId) if any — don't clobber others.
  if (watches.has(watchKey(chatId, threadId))) {
    stopWatching(chatId, threadId, botApi, "auto-replace");
  }

  await forceRefresh();
  const sessionInfo = getSession(sessionName);
  if (!sessionInfo?.id) {
    warn("auto-watch: start failed, missing session id", {
      chatId,
      threadId,
      sessionName,
    });
    return false;
  }

  const jsonlPath =
    (await findSessionJsonlPath(sessionInfo.id)) ??
    getExpectedJsonlPath(sessionInfo.dir, sessionInfo.id);

  const tailer = new SessionTailer(jsonlPath, (event: TailEvent) => {
    handleTailEvent(botApi, watchState, event, watchState.threadId);
  });
  const watchState: WatchState = buildWatchState({
    sessionName,
    sessionId: sessionInfo.id,
    sessionDir: sessionInfo.dir,
    sessionPid: sessionInfo.pid,
    tailer,
    chatId,
    threadId,
  });
  watches.set(watchKey(chatId, threadId), watchState);
  await tailer.start();

  setupIdDriftDetection(botApi, watchState);

  // Wire relay client for replies
  const relayClient = await getRelayClient({
    sessionId: sessionInfo.id,
    sessionDir: sessionInfo.dir,
    claudePid: sessionInfo.pid,
  });
  if (relayClient) {
    const scopeChatId = String(chatId);
    const onReply = (msg: RelayReply) => {
      watchState.suppressRelayReplyText = true;
      const tid = watchState.threadId;

      if (msg.send_as_pdf && msg.text) {
        sendPdfReply(botApi, chatId, msg.text, msg.pdf_filename, tid);
      } else if (msg.text) {
        sendTextReply(botApi, chatId, msg.text, tid);
      }

      if (msg.files?.length) {
        for (const filePath of msg.files) {
          sendFile(botApi, chatId, filePath, tid).catch((err) =>
            warn(`auto-watch file: ${err}`),
          );
        }
      }
    };
    relayClient.onReply(onReply, scopeChatId);
    watchState.relayCleanup = () => relayClient.offReply(onReply);
  }

  info("auto-watch: started", {
    chatId,
    threadId,
    sessionName,
    sessionId: sessionInfo.id,
    sessionDir: sessionInfo.dir,
  });
  return true;
}

/**
 * /watch [session-name] - Start watching a desktop session.
 */
export async function handleWatch(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;

  if (!userId || !chatId) return;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (threadId === undefined) {
    await ctx.reply(
      "ℹ️ Watching is per-topic. Use /spawn to create a topic for your session.",
    );
    return;
  }

  // Don't start watching while a query is running
  if (session.isRunning) {
    await ctx.reply("A query is in progress. Use /stop first.");
    return;
  }

  // Already watching?
  if (watches.has(watchKey(chatId, threadId))) {
    const existing = watches.get(watchKey(chatId, threadId))!;
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

  const started = await startWatchingAndNotify(
    ctx,
    chatId,
    threadId,
    targetName,
    "command",
  );
  if (!started) {
    await ctx.reply("Could not start watching (no session ID).");
  }
}

/**
 * Start watching a session by name. Returns true on success.
 * Used by /watch command and auto-watch on /switch.
 */
export async function startWatchingSession(
  botApi: Api,
  chatId: number,
  threadId: number,
  targetName: string,
  reason = "watch",
): Promise<boolean> {
  // Stop existing watch if any
  if (watches.has(watchKey(chatId, threadId))) {
    stopWatching(chatId, threadId, botApi, "replace");
  }

  // Poll for session ID — freshly spawned sessions need a moment for the
  // relay port file to land in /tmp.
  let sessionInfo: ReturnType<typeof getSession> = null;
  const watchDeadline = Date.now() + 6_000;

  while (Date.now() < watchDeadline) {
    await forceRefresh();
    sessionInfo = getSession(targetName);
    if (sessionInfo?.id) break;
    await Bun.sleep(1_000);
  }

  if (!sessionInfo?.id) {
    warn("watch: start failed, missing session id", {
      chatId,
      threadId,
      targetName,
    });
    return false;
  }

  // Resolve JSONL path. May not exist yet — claude doesn't write the file
  // until the first prompt is submitted. Fall back to the expected path so
  // the tailer can wait for the file to appear.
  const jsonlPath =
    (await findSessionJsonlPath(sessionInfo.id)) ??
    getExpectedJsonlPath(sessionInfo.dir, sessionInfo.id);

  const tailer = new SessionTailer(jsonlPath, (event: TailEvent) => {
    handleTailEvent(botApi, watchState, event, watchState.threadId);
  });
  // Spawn-initiated watches: the seeded sessionId is almost certainly
  // the watcher's stale-JSONL fallback for this dir. When the real id
  // shows up (after the first user prompt) we restart the tailer but
  // skip the "reconnected" broadcast — there's no prior conversation.
  const watchState: WatchState = buildWatchState({
    sessionName: targetName,
    sessionId: sessionInfo.id,
    sessionDir: sessionInfo.dir,
    sessionPid: sessionInfo.pid,
    tailer,
    chatId,
    threadId,
    suppressNextIdChangeNotice: reason === "spawn",
  });
  watches.set(watchKey(chatId, threadId), watchState);
  await tailer.start();

  setupIdDriftDetection(botApi, watchState);

  // Wire relay client for replies. The JSONL tailer normally handles text
  // display, but if the tailer is stale (e.g. after /clear) the TCP path
  // is the only way the reply reaches us. suppressRelayReplyText prevents
  // the tailer from duplicating text that TCP already delivered.
  const relayClient = await getRelayClient({
    sessionId: sessionInfo.id,
    sessionDir: sessionInfo.dir,
    claudePid: sessionInfo.pid,
  });
  if (relayClient) {
    const scopeChatId = String(chatId);
    const onReply = (msg: RelayReply) => {
      watchState.suppressRelayReplyText = true;
      const tid = watchState.threadId;

      if (msg.send_as_pdf && msg.text) {
        sendPdfReply(botApi, chatId, msg.text, msg.pdf_filename, tid);
      } else if (msg.text) {
        sendTextReply(botApi, chatId, msg.text, tid);
      }

      if (msg.files?.length) {
        for (const filePath of msg.files) {
          sendFile(botApi, chatId, filePath, tid).catch((err) =>
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

  info("watch: started", {
    chatId,
    threadId,
    sessionName: targetName,
    sessionId: sessionInfo.id,
    sessionDir: sessionInfo.dir,
    pid: sessionInfo.pid,
    reason,
  });
  return true;
}

/**
 * Start watching + send the standard notification reply.
 * Returns true if watch started successfully.
 */
export async function startWatchingAndNotify(
  ctx: Context,
  chatId: number,
  threadId: number,
  sessionName: string,
  reason = "watch",
): Promise<boolean> {
  const watching = await startWatchingSession(
    ctx.api,
    chatId,
    threadId,
    sessionName,
    reason,
  );
  if (!watching) return false;

  const sessionInfo = getSession(sessionName);
  const dir = (sessionInfo?.dir || "").replace(/^\/Users\/[^/]+/, "~");

  const history = await getRecentHistory(sessionInfo?.id, 1, sessionInfo?.dir);
  const lastPair = history[history.length - 1];
  let lastMsgLine = "";
  if (lastPair) {
    const parts: string[] = [];
    if (lastPair.user) {
      const u =
        lastPair.user.length > 150
          ? lastPair.user.slice(0, 150) + "…"
          : lastPair.user;
      parts.push(`👤 ${escapeHtml(u)}`);
    }
    if (lastPair.assistant) {
      const a =
        lastPair.assistant.length > 300
          ? lastPair.assistant.slice(0, 300) + "…"
          : lastPair.assistant;
      parts.push(`🤖 ${escapeHtml(a)}`);
    }
    if (parts.length)
      lastMsgLine = `\n<blockquote>${parts.join("\n")}</blockquote>`;
  }

  await ctx.reply(
    `👁 Watching <b>${escapeHtml(sessionName)}</b>\n` +
      `📁 <code>${escapeHtml(dir)}</code>${lastMsgLine}\n\n` +
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
  const threadId = ctx.message?.message_thread_id;

  if (!userId || !chatId) return;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (threadId === undefined) {
    await ctx.reply("ℹ️ Unwatching is per-topic.");
    return;
  }

  const state = stopWatching(chatId, threadId, ctx.api, "unwatch");

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
    await ctx.reply("Not currently watching any session in this topic.");
  }
}

/** Test seam — clear internal watch + typing state. Do NOT call from app code. */
export function _resetWatchesForTests(): void {
  for (const [, state] of watches) {
    try {
      state.tailer.stop();
    } catch {}
    state.relayCleanup?.();
    if (state.idCheckInterval) clearInterval(state.idCheckInterval);
  }
  watches.clear();
  typingState.clear();
}

/** Test seam — register a pre-built WatchState without starting a tailer. */
export function _registerWatchForTests(state: WatchState): void {
  watches.set(watchKey(state.chatId, state.threadId), state);
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
  threadId?: number,
): void {
  if (state.finalReplyReceived) return;

  const { chatId } = state;
  const threadOpts = threadId ? { message_thread_id: threadId } : {};

  // Typing only during "working" phases — stop when user-visible output arrives.
  // Only for watches (threadId present); relay display has no topic context.
  if (threadId !== undefined) {
    if (
      event.type === "thinking" ||
      event.type === "tool" ||
      event.type === "user"
    ) {
      touchWatchTyping(botApi, chatId, threadId);
    } else {
      stopWatchTyping(chatId, threadId);
    }
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
          ...threadOpts,
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
        .sendMessage(chatId, event.content, {
          parse_mode: "HTML",
          ...threadOpts,
        })
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
          .sendMessage(chatId, formatted, { parse_mode: "HTML", ...threadOpts })
          .then((msg) => {
            state.currentTextMsg = msg;
            trackProgress(msg);
          })
          .catch((err) => {
            debug(`tail text create: ${err}`);
            botApi
              .sendMessage(chatId, display, threadOpts)
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
      // Only RelayDisplayState initialises finalReplyReceived (to false);
      // WatchState leaves it undefined. Setting it here lets wireRelayDisplay
      // (TCP path) skip text delivery when the tailer wins the race.
      if (state.finalReplyReceived !== undefined) {
        state.finalReplyReceived = true;
      }

      if (state.currentToolMsg) {
        botApi
          .deleteMessage(chatId, state.currentToolMsg.message_id)
          .catch(() => {});
        state.currentToolMsg = null;
      }
      if (state.currentTextMsg && !state.segmentDone) {
        finalizeTextMessage(botApi, state);
      }

      const ws = state as WatchState;
      if (ws.suppressRelayReplyText) {
        ws.suppressRelayReplyText = false;
      } else {
        sendTextReply(botApi, chatId, event.content);
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
          ? event.content.slice(0, 300) + "…"
          : event.content;
      const formatted = convertMarkdownToHtml(preview);
      botApi
        .sendMessage(chatId, `🖥 <b>Desktop:</b>\n${formatted}`, {
          parse_mode: "HTML",
          ...threadOpts,
        })
        .catch((err) => {
          debug(`tail user: ${err}`);
          botApi
            .sendMessage(chatId, `🖥 Desktop:\n${preview}`, threadOpts)
            .catch(() => {});
        });

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
