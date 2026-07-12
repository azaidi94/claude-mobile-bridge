/**
 * Session-control commands: /stop, /retry, /status, /model, /restart, /pin,
 * /switch, /run.
 */

import type { Context } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { getWorkingDir } from "../../settings";
import { isAuthorized } from "../../security";
import { MODEL_OPTIONS, getCurrentModelDisplayName } from "../../session";
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
 * Shared abort path for /stop and /interrupt.
 *
 * /interrupt is the gentle version: cancel the current SDK query and let any
 * pending interactive state (plan approval, ask-user-question, settings
 * prompt) stay alive so the user can finish what they were in the middle of.
 *
 * /stop is the heavy version: cancel the query AND clear pending interactive
 * state for this chat — fresh slate. Useful when an AUQ/plan-approval is
 * stuck or no longer wanted.
 */
async function abortQuery(
  ctx: Context,
  sctx: SessionContext | undefined,
  clearPendings: boolean,
  verbLabel: string,
): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  if (!sctx && (await resolveTopicSession(ctx, `${verbLabel}_pick`))) return;

  const state =
    sctx && sctx.source === "cc" ? getSessionState(sctx.sessionName) : null;
  const result = state ? await state.stop() : false;

  const chatId = ctx.chat?.id;
  let clearedNote = "";
  if (clearPendings && chatId !== undefined) {
    const cleared: string[] = [];
    const { pendingPlanFeedback } = await import("../callback");
    const { pendingAskUserQuestionCustom, pendingKey } =
      await import("../streaming");
    const { pendingSettingsInput } = await import("../settings");
    // Pending-input maps are keyed by (chatId, threadId) so a prompt in one
    // forum topic can't be cleared/consumed from another. Stop runs inside the
    // same topic, so clear that topic's slot.
    const pk = pendingKey(chatId, ctx.message?.message_thread_id);
    if (pendingPlanFeedback.delete(pk)) cleared.push("plan");
    if (pendingAskUserQuestionCustom.delete(pk)) cleared.push("question");
    if (pendingSettingsInput.delete(pk)) cleared.push("settings");
    if (state) state.clearPendingPlanApproval();
    if (cleared.length) clearedNote = ` (cleared: ${cleared.join(", ")})`;
  }

  if (result === "stopped") {
    await busReply(ctx, `🛑 Query stopped.${clearedNote}`);
  } else if (result === "pending") {
    await busReply(ctx, `⏳ Cancelling...${clearedNote}`);
  } else if (clearedNote) {
    await busReply(ctx, `⏸️ Nothing running${clearedNote}.`);
  } else {
    await busReply(ctx, "⏸️ Nothing running.");
  }

  await Bun.sleep(100);
  if (state) state.clearStopRequested();
}

/**
 * /stop - Abort current query AND clear any pending interactive state
 * (plan approval, ask-user-question, settings prompt) for this chat.
 */
export async function handleStop(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  await abortQuery(ctx, sctx, true, "stop");
}

/**
 * /interrupt - Abort the current query but preserve any pending interactive
 * state. Gentler than /stop — use this to cut a stuck run when you still
 * want to answer an open plan/question afterwards.
 */
export async function handleInterrupt(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  await abortQuery(ctx, sctx, false, "interrupt");
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
 * /model - Switch the live desktop session's model. Tapping a button injects
 * `/config model=<arg>` into the session's TUI (see the model: callback); the
 * session must be an injectable Claude Code session, so this requires session
 * context exactly like /clear.
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

  if (!sctx) {
    await busReply(ctx, "Use /model in a Claude session topic.");
    return;
  }
  if (sctx.source !== "cc") {
    await busReply(
      ctx,
      `/model isn't supported for ${sctx.source} sessions yet.`,
    );
    return;
  }

  // Carry the target session in the callback so the switch injects into the
  // right TUI regardless of which topic the buttons end up living in (the
  // General-picker path renders them outside the session's own topic). Encode
  // the model as its index (1 char), not the configArg, and put the session
  // name last so `model:<idx>:<name>` stays under Telegram's 64-byte
  // callback_data limit even for long session names.
  const buttons = MODEL_OPTIONS.map((o, i) => [
    {
      text: o.label,
      callback_data: `model:${i}:${sctx.sessionName}`,
    },
  ]);

  await busReply(
    ctx,
    `🤖 <b>Switch model</b> — <code>${sctx.sessionName}</code>`,
    { format: "html", replyMarkup: { inline_keyboard: buttons } },
  );
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

  await handleText(ctx, sctx, message);
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
