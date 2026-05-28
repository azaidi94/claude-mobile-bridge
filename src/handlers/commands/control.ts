/**
 * Session-control commands: /stop, /retry, /status, /model, /restart, /pin,
 * /switch, /run.
 */

import type { Context } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { getWorkingDir } from "../../settings";
import { isAuthorized } from "../../security";
import {
  MODEL_DISPLAY_NAMES,
  getCurrentModel,
  getCurrentModelDisplayName,
  type ModelId,
} from "../../session";
import { getSessionState } from "../../sessions/session-state";
import { triggerRestart } from "../../lifecycle";
import { getGitBranch, updatePinnedStatus } from "../../sessions";
import type { SessionContext } from "../../sessions/context";
import { getLastUsage, formatContextLine } from "../../sessions/context-usage";
import { isRelayAvailable } from "../../relay";
import { getWatch } from "../watch";
import { getMessageBus } from "../../messaging";
import { busReply, resolveTopicSession } from "./helpers";

/**
 * /stop - Interrupt current generation or cancel queue.
 */
export async function handleStop(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  if (!sctx && (await resolveTopicSession(ctx, "stop_pick"))) return;

  const state =
    sctx && sctx.source === "cc" ? getSessionState(sctx.sessionName) : null;
  const result = state ? await state.stop() : false;

  if (result === "stopped") {
    await busReply(ctx, "🛑 Query stopped.");
  } else if (result === "pending") {
    await busReply(ctx, "⏳ Cancelling...");
  } else {
    await busReply(ctx, "⏸️ Nothing running.");
  }

  await Bun.sleep(100);
  if (state) state.clearStopRequested();
}

/**
 * /status - Show detailed status.
 */
export async function handleStatus(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  if (!sctx && (await resolveTopicSession(ctx, "status_pick"))) return;

  const state =
    sctx && sctx.source === "cc" ? getSessionState(sctx.sessionName) : null;
  const sessionName = sctx?.sessionName ?? state?.sessionName;

  if (!sessionName) {
    await busReply(ctx, "No session. Use /list or /new.");
    return;
  }

  const lines: string[] = [`📊 <b>${sessionName}</b>\n`];

  // Model (global per R3)
  lines.push(`🤖 ${getCurrentModelDisplayName()}`);

  // Session/query status — read entirely from per-state
  if (state) {
    if (state.isRunning) {
      const elapsed = state.queryStarted
        ? Math.floor((Date.now() - state.queryStarted.getTime()) / 1000)
        : 0;
      lines.push(`🔄 Running (${elapsed}s)`);
      if (state.currentTool) {
        lines.push(`   └─ ${state.currentTool}`);
      }
    } else if (state.isActive) {
      lines.push(`✅ Ready (${state.sessionId?.slice(0, 8)}...)`);
      if (state.lastTool) {
        lines.push(`   └─ Last: ${state.lastTool}`);
      }
    } else {
      lines.push("⏳ Not started");
    }

    if (state.lastActivity) {
      const ago = Math.floor(
        (Date.now() - state.lastActivity.getTime()) / 1000,
      );
      lines.push(`⏱️ ${ago}s ago`);
    }
  }

  // Context window usage. Prefer the live watch's sessionId — it tracks ID
  // drift (compact / new conversation in the desktop CC) more reliably than
  // the SessionState snapshot.
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;
  const watch =
    chatId && threadId !== undefined ? getWatch(chatId, threadId) : undefined;
  const sid = watch?.sessionId || sctx?.sessionId || state?.sessionId;
  if (sid) {
    const usage = getLastUsage(sid);
    if (usage) {
      lines.push(formatContextLine(usage));
    }
  }

  if (state?.lastError) {
    lines.push(`⚠️ ${state.lastError.slice(0, 50)}`);
  }

  const dir = (
    sctx?.sessionDir ||
    state?.workingDir ||
    getWorkingDir()
  ).replace(/^\/Users\/[^/]+/, "~");
  lines.push(`📁 <code>${dir}</code>`);

  const branchDir = sctx?.sessionDir || state?.workingDir;
  const branch = branchDir ? await getGitBranch(branchDir) : null;
  if (branch) {
    lines.push(`🌿 <code>${branch}</code>`);
  }

  const relayUp = await isRelayAvailable({
    sessionId: sctx?.sessionId || state?.sessionId || undefined,
    sessionDir: sctx?.sessionDir || state?.workingDir,
    claudePid: sctx?.sessionPid,
  });
  lines.push(relayUp ? "📡 Relay: connected" : "📡 Relay: unavailable");

  const resumeId = state?.sessionId;
  if (resumeId) {
    lines.push(`\n🔗 <code>claude --resume ${resumeId}</code>`);
  }

  await busReply(ctx, lines.join("\n"), "html");
}

/**
 * /model - Show/switch model with inline buttons.
 */
export async function handleModel(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  if (!sctx && (await resolveTopicSession(ctx, "model_pick"))) return;

  // Model state is global (R3).
  const currentModel = getCurrentModel();
  const models = Object.entries(MODEL_DISPLAY_NAMES) as [ModelId, string][];

  const buttons = models.map(([id, name]) => [
    {
      text: id === currentModel ? `✓ ${name}` : name,
      callback_data: `model:${id}`,
    },
  ]);

  await busReply(ctx, `🤖 <b>Model:</b> ${getCurrentModelDisplayName()}`, {
    format: "html",
    replyMarkup: { inline_keyboard: buttons },
  });
}

/**
 * /restart - Restart the bot runner in-process.
 */
export async function handleRestart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const bus = getMessageBus();
  const sent = await bus.send({
    chatId,
    threadId: ctx.message?.message_thread_id,
    content: "🔄 Restarting...",
    format: "plain",
  });
  const messageId = "messageId" in sent ? sent.messageId : null;

  try {
    triggerRestart();
    if (messageId !== null) {
      await bus.edit(messageId, {
        chatId,
        content: "✅ Restarted",
        format: "plain",
      });
    }
  } catch (e) {
    if (messageId !== null) {
      await bus
        .edit(messageId, {
          chatId,
          content: `❌ Restart failed: ${e}`,
          format: "plain",
        })
        .catch(() => {});
    }
  }
}

/**
 * /retry - Retry the last message.
 */
export async function handleRetry(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  if (!sctx || sctx.source !== "cc") {
    await busReply(ctx, "Use /retry in a session topic.");
    return;
  }

  const state = getSessionState(sctx.sessionName);

  if (!state.lastMessage) {
    await busReply(ctx, "❌ No message to retry.");
    return;
  }

  if (state.isRunning) {
    await busReply(ctx, "⏳ Query running. Use /stop first.");
    return;
  }

  const message = state.lastMessage;
  await busReply(ctx, `🔄 Retrying...`);

  const { handleText } = await import("../text");

  const fakeCtx = {
    ...ctx,
    message: { ...ctx.message, text: message },
  } as Context;

  await handleText(fakeCtx, sctx);
}

/**
 * /pin - Update/create pinned status message.
 */
export async function handlePin(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  if (!chatId) return;

  const state =
    sctx && sctx.source === "cc" ? getSessionState(sctx.sessionName) : null;
  const branch = await getGitBranch(
    sctx?.sessionDir || state?.workingDir || getWorkingDir(),
  );
  const status = {
    sessionName: sctx?.sessionName || state?.sessionName || null,
    isPlanMode: state?.isPlanMode ?? false,
    model: getCurrentModelDisplayName(),
    branch,
  };

  await updatePinnedStatus(ctx.api, chatId, status);
  await busReply(ctx, "📌 Status pinned.");
}
