/**
 * Text message handler for Claude Telegram Bot.
 */

import type { Context } from "grammy";
import { session } from "../session";
import { ALLOWED_USERS } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import {
  auditLog,
  auditLogRateLimit,
  checkInterrupt,
  startTypingIndicator,
} from "../utils";
import {
  StreamingState,
  createStatusCallback,
  createPlanApprovalKeyboard,
  createAskUserQuestionKeyboard,
  pendingAskUserQuestions,
  pendingAskUserQuestionCustom,
  sendPlanContent,
} from "./streaming";
import { getActiveSession, getSession, setActiveSession } from "../sessions";
import { pendingPlanFeedback } from "./callback";
import { isWatching, stopWatching, sendWatchRelay } from "./watch";
import { getActiveQueue, parseTasks } from "../queue";
import { debug, info, truncate } from "../logger";
import { sendViaRelay } from "./relay-bridge";

/**
 * Handle incoming text messages.
 */
export async function handleText(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  let message = ctx.message?.text;

  if (!userId || !message || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 1.5. Check for pending plan feedback
  if (pendingPlanFeedback.has(chatId)) {
    const requestId = pendingPlanFeedback.get(chatId)!;
    pendingPlanFeedback.delete(chatId);

    // Check if there's still a pending plan approval
    if (!session.pendingPlanApproval) {
      await ctx.reply("❌ Plan approval expired.");
      return;
    }

    // Process feedback
    const typing = startTypingIndicator(ctx);
    const state = new StreamingState();
    const statusCallback = createStatusCallback(ctx, state);

    try {
      const response = await session.respondToPlanApproval(
        "edit",
        message,
        ctx.from?.username || "unknown",
        userId,
        statusCallback,
        chatId,
        ctx,
      );

      // Check if another plan approval is pending
      if (session.pendingPlanApproval) {
        const newRequestId = `${Date.now()}`;
        const keyboard = createPlanApprovalKeyboard(newRequestId);
        await ctx.reply("📋 Revised plan ready. Review and approve?", {
          reply_markup: keyboard,
        });
      }

      await auditLog(
        userId,
        ctx.from?.username || "unknown",
        "PLAN_EDIT",
        message,
        response,
      );
    } catch (err) {
      debug(`plan feedback error: ${err}`);
      await ctx.reply(`❌ Error: ${String(err).slice(0, 200)}`);
    } finally {
      typing.stop();
    }
    return;
  }

  // 1.6. Check for pending AskUserQuestion custom input
  if (pendingAskUserQuestionCustom.has(chatId)) {
    const requestId = pendingAskUserQuestionCustom.get(chatId)!;
    pendingAskUserQuestionCustom.delete(chatId);

    const pending = pendingAskUserQuestions.get(requestId);
    if (!pending) {
      await ctx.reply("❌ Question expired.");
      return;
    }

    // Add custom answer
    pending.answers.push(message);
    pending.currentIndex++;

    if (pending.currentIndex < pending.questions.length) {
      // Show next question
      const nextQ = pending.questions[pending.currentIndex]!;
      let questionText = `❓ ${nextQ.question}`;
      if (nextQ.header) {
        questionText = `<b>${nextQ.header}</b>\n\n${questionText}`;
      }
      const keyboard = createAskUserQuestionKeyboard(
        nextQ,
        requestId,
        pending.currentIndex,
        pending.questions.length,
      );
      await ctx.reply(questionText, {
        reply_markup: keyboard,
        parse_mode: "HTML",
      });
    } else {
      // All questions answered - send to Claude
      const wasPlanMode = pending.isPlanMode;
      pendingAskUserQuestions.delete(requestId);
      const answersText = pending.answers.join(", ");
      await ctx.reply(`✅ Answered: ${answersText}`);

      // Send answers to Claude (preserve plan mode)
      const typing = startTypingIndicator(ctx);
      const state = new StreamingState();
      const statusCallback = createStatusCallback(ctx, state);

      try {
        const permissionMode = wasPlanMode ? "plan" : "bypassPermissions";
        const response = await session.sendMessageStreaming(
          answersText,
          username,
          userId,
          statusCallback,
          chatId,
          ctx,
          permissionMode,
        );
        await auditLog(userId, username, "AUQ_CUSTOM", message, response);

        // Check if plan approval is pending (ExitPlanMode was called)
        if (session.pendingPlanApproval) {
          const displayContent =
            session.pendingPlanApproval.planContent ||
            session.pendingPlanApproval.planSummary;
          if (displayContent && displayContent.length > 50) {
            await sendPlanContent(ctx, displayContent);
          }

          const keyboard = createPlanApprovalKeyboard(`${Date.now()}`);
          await ctx.reply("Review and approve?", { reply_markup: keyboard });
        }
      } catch (err) {
        debug(`AUQ custom error: ${err}`);
        await ctx.reply(`❌ Error: ${String(err).slice(0, 200)}`);
      } finally {
        typing.stop();
      }
    }
    return;
  }

  // 1.7. Check for active watch — relay or takeover
  if (isWatching(chatId)) {
    // Try relay first (keeps desktop session alive)
    const relayed = await sendWatchRelay(chatId, username, message);
    if (relayed) {
      ctx.replyWithChatAction("typing").catch(() => {});
      await auditLog(userId, username, "WATCH_RELAY", message, "(via relay)");
      return;
    }

    // No relay — fall back to takeover
    const watchState = stopWatching(chatId, ctx.api);
    if (watchState) {
      info(`takeover: ${watchState.sessionName} from chat ${chatId}`);
      await ctx.reply(`🔄 Taking over <b>${watchState.sessionName}</b>...`, {
        parse_mode: "HTML",
      });

      // Load the desktop session for mobile use
      const sessionInfo = getSession(watchState.sessionName);
      if (!sessionInfo) {
        await ctx.reply(
          `❌ Session <b>${watchState.sessionName}</b> is no longer available.`,
          { parse_mode: "HTML" },
        );
        return;
      }
      session.loadFromRegistry(sessionInfo);
      setActiveSession(watchState.sessionName);
      // Fall through to send the message normally via sendMessageStreaming
    }
  }

  // 2. Check for interrupt prefix
  message = await checkInterrupt(message);
  if (!message.trim()) {
    return;
  }

  // 2.5. Append to queue if one is running
  const activeQueue = getActiveQueue();
  if (activeQueue) {
    // Parse multi-line messages into separate tasks
    const tasks = message.includes("\n") ? parseTasks(message) : [message];
    for (const task of tasks) {
      activeQueue.addTask(task);
    }
    if (tasks.length === 1) {
      const desc =
        tasks[0]!.length > 60 ? tasks[0]!.slice(0, 60) + "..." : tasks[0]!;
      await ctx.reply(
        `📋 Added to queue as task ${activeQueue.tasks.length}: ${desc}`,
      );
    } else {
      await ctx.reply(
        `📋 Added ${tasks.length} task(s) to queue (now ${activeQueue.tasks.length} total).`,
      );
    }
    return;
  }

  // 3. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`,
    );
    return;
  }

  // 4. Handle /clear locally (SDK doesn't support it)
  if (message.trim() === "/clear") {
    session.sessionId = null;
    await ctx.reply("✓ Session cleared");
    await auditLog(userId, username, "CLEAR", message, "Session cleared");
    return;
  }

  // 5. Store message for retry
  session.lastMessage = message;

  // Debug log incoming message
  debug(`msg: "${truncate(message)}"`);

  // 7. Sync with registry if no session loaded
  if (!session.sessionName) {
    const active = await getActiveSession();
    if (active) {
      session.loadFromRegistry(active.info);
    }
  }

  // 7.5. Try relay path — inject into running desktop session without takeover
  const relayResult = await sendViaRelay(ctx, message, username, chatId);
  if (relayResult) {
    await auditLog(userId, username, "RELAY", message, "(via relay)");
    return;
  }

  // 8. Mark processing started
  const stopProcessing = session.startProcessing();

  // 9. Start typing indicator
  const typing = startTypingIndicator(ctx);

  // 10. Create streaming state and callback
  let state = new StreamingState();
  let statusCallback = createStatusCallback(ctx, state);

  // 11. Send to Claude with retry logic for crashes
  const MAX_RETRIES = 1;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await session.sendMessageStreaming(
        message,
        username,
        userId,
        statusCallback,
        chatId,
        ctx,
      );

      // Debug log response
      debug(`res: "${truncate(response)}"`);

      // 12. Audit log
      await auditLog(userId, username, "TEXT", message, response);

      // 13. Check if plan approval is pending (ExitPlanMode was called)
      if (session.pendingPlanApproval) {
        const approval = session.pendingPlanApproval;
        const requestId = `${Date.now()}`;

        // Send plan content
        if (approval.planContent) {
          await sendPlanContent(ctx, approval.planContent);
        }

        // Show approval buttons
        const keyboard = createPlanApprovalKeyboard(requestId);
        await ctx.reply("Review and approve?", { reply_markup: keyboard });
      }

      break; // Success - exit retry loop
    } catch (error) {
      const errorStr = String(error);
      const isClaudeCodeCrash = errorStr.includes("exited with code");

      // Clean up any partial messages from this attempt
      for (const toolMsg of state.toolMessages) {
        try {
          await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
        } catch {
          // Ignore cleanup errors
        }
      }

      // Retry on Claude Code crash (not user cancellation)
      if (isClaudeCodeCrash && attempt < MAX_RETRIES) {
        debug(`crash, retry ${attempt + 2}/${MAX_RETRIES + 1}`);
        await session.kill(); // Clear corrupted session
        await ctx.reply(`⚠️ Claude crashed, retrying...`);
        // Reset state for retry
        state = new StreamingState();
        statusCallback = createStatusCallback(ctx, state);
        continue;
      }

      // Final attempt failed or non-retryable error
      debug(`msg error: ${error}`);

      // Check if it was a cancellation
      if (errorStr.includes("abort") || errorStr.includes("cancel")) {
        // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
        const wasInterrupt = session.consumeInterruptFlag();
        if (!wasInterrupt) {
          await ctx.reply("🛑 Query stopped.");
        }
      } else {
        await ctx.reply(`❌ Error: ${errorStr.slice(0, 200)}`);
      }
      break; // Exit loop after handling error
    }
  }

  // 14. Cleanup
  stopProcessing();
  typing.stop();
}
