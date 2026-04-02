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
import { getActiveSession } from "../sessions";
import { pendingPlanFeedback } from "./callback";
import { isWatching, sendWatchRelay } from "./watch";
import { getActiveQueue, parseTasks } from "../queue";
import { debug, truncate } from "../logger";
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

  // 1.7. Check for active watch — relay message to desktop session
  if (isWatching(chatId)) {
    const relayed = await sendWatchRelay(chatId, username, message);
    if (relayed) {
      ctx.replyWithChatAction("typing").catch(() => {});
      await auditLog(userId, username, "WATCH_RELAY", message, "(via relay)");
      return;
    }

    // Relay failed — session may be offline
    await ctx.reply(
      "❌ Relay failed. Session may be offline.\n" +
        "Use /unwatch and check /list.",
    );
    return;
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

  // 7.5. Try relay path — inject into running desktop session
  const relayResult = await sendViaRelay(ctx, message, username, chatId);
  if (relayResult) {
    await auditLog(userId, username, "RELAY", message, "(via relay)");
    return;
  }

  // No relay available — tell the user
  await ctx.reply(
    "❌ No desktop session found.\n\n" +
      "Use /new to spawn one, or /list to find existing sessions.",
  );
}
