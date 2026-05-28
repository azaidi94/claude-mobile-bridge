/**
 * `/watch` + `/unwatch` Telegram command handlers, plus the
 * `startWatchingAndNotify` wrapper that pairs `startWatchingSession` with
 * the standard "now watching" reply card.
 *
 * Heavy lifting (tailer wiring, drift detection, cleanup) lives in
 * `session-builder.ts` and `cleanup.ts`.
 */

import type { Context } from "grammy";
import { getCurrentModelDisplayName } from "../../session";
import { getSessionState, getSessions } from "../../sessions";
import { ALLOWED_USERS } from "../../config";
import { isAuthorized } from "../../security";
import { escapeHtml } from "../../formatting";
import { getSession, updatePinnedStatus, getGitBranch } from "../../sessions";
import { getMessageBus } from "../../messaging";
import { getRecentHistory } from "../../sessions/history";
import type { SessionContext } from "../../sessions/context";
import { stopWatching } from "./cleanup";
import { watchKey, watches } from "./registry";
import { startWatchingSession } from "./session-builder";

/**
 * Bus-routed reply helper for /watch + /unwatch command handlers. Status-msg
 * pattern sites (streaming bubbles upstream in this file) still use the bus
 * directly because they need the returned `messageId` for later edit/delete.
 */
function busReply(
  ctx: Context,
  content: string,
  opts: { format?: "plain" | "html" } = {},
): Promise<unknown> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return Promise.resolve();
  return getMessageBus().send({
    chatId,
    threadId: ctx.message?.message_thread_id,
    content,
    format: opts.format ?? "plain",
  });
}

/**
 * /watch [session-name] - Start watching a desktop session.
 */
export async function handleWatch(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;

  if (!userId || !chatId) return;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  if (threadId === undefined) {
    await busReply(
      ctx,
      "ℹ️ Watching is per-topic. Use /spawn to create a topic for your session.",
    );
    return;
  }

  // Don't start watching while a query is running on this topic's session.
  // (For General-topic /watch with no sctx, there's no specific session to
  // check; the watch target is parsed below.)
  if (sctx?.sessionName) {
    const st = getSessionState(sctx.sessionName);
    if (st.isRunning) {
      await busReply(ctx, "A query is in progress. Use /stop first.");
      return;
    }
  }

  // Already watching?
  if (watches.has(watchKey(chatId, threadId))) {
    const existing = watches.get(watchKey(chatId, threadId))!;
    await busReply(
      ctx,
      `Already watching <b>${escapeHtml(existing.sessionName)}</b>. Use /unwatch first.`,
      { format: "html" },
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
      await busReply(
        ctx,
        `Session "${escapeHtml(requestedName)}" not found. Use /list.`,
        { format: "html" },
      );
      return;
    }
    if (sessionInfo.source !== "desktop") {
      await busReply(ctx, "Can only watch desktop sessions.");
      return;
    }
    targetName = requestedName;
  } else if (sctx?.sessionName) {
    // Topic-resolved session takes precedence over the global active pointer.
    const sessionInfo = getSession(sctx.sessionName);
    if (sessionInfo && sessionInfo.source === "desktop") {
      targetName = sctx.sessionName;
    }
  }

  if (!targetName && !requestedName) {
    // Fallback when sctx is unavailable (private DM) or its session isn't
    // a desktop session — pick the first desktop session in the registry.
    const allSessions = getSessions();
    const desktop = allSessions.find((s) => s.source === "desktop");
    if (desktop) {
      targetName = desktop.name;
    }
  }

  if (!targetName) {
    await busReply(
      ctx,
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
    await busReply(ctx, "Could not start watching (no session ID).");
  }
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

  await busReply(
    ctx,
    `👁 Watching <b>${escapeHtml(sessionName)}</b>\n` +
      `📁 <code>${escapeHtml(dir)}</code>${lastMsgLine}\n\n` +
      `Live events will stream here.\n` +
      `Type a message to send via relay.\n` +
      `Use /unwatch to stop.`,
    { format: "html" },
  );
  return true;
}

/**
 * /unwatch - Stop watching.
 */
export async function handleUnwatch(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;

  if (!userId || !chatId) return;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  if (threadId === undefined) {
    await busReply(ctx, "ℹ️ Unwatching is per-topic.");
    return;
  }

  const state = stopWatching(chatId, threadId, ctx.api, "unwatch");

  if (state) {
    await busReply(
      ctx,
      `Stopped watching <b>${escapeHtml(state.sessionName)}</b>.`,
      { format: "html" },
    );

    // Restore normal pinned status. Without sctx we have no session to
    // attribute to — leave name null and use cwd. Plan-mode comes from the
    // per-session SessionState; model is global (R3).
    const sessionName = sctx?.sessionName || null;
    const dir = sctx?.sessionDir || process.cwd();
    const isPlanMode = sessionName
      ? getSessionState(sessionName).isPlanMode
      : false;
    const branch = await getGitBranch(dir);
    updatePinnedStatus(ctx.api, chatId, {
      sessionName,
      isPlanMode,
      model: getCurrentModelDisplayName(),
      branch,
    }).catch(() => {});
  } else {
    await busReply(ctx, "Not currently watching any session in this topic.");
  }
}
