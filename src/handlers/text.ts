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
} from "./streaming";
import { getActiveSession, getSession } from "../sessions";
import { pendingPlanFeedback } from "./callback";

/**
 * Handle incoming text messages.
 */
export async function handleText(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  let message = ctx.message?.text;

  console.log(`[TEXT] Received: "${message?.slice(0, 50)}..."`);

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
        ctx
      );

      // Check if another plan approval is pending
      if (session.pendingPlanApproval) {
        const newRequestId = `${Date.now()}`;
        const keyboard = createPlanApprovalKeyboard(newRequestId);
        await ctx.reply("📋 Revised plan ready. Review and approve?", { reply_markup: keyboard });
      }

      await auditLog(userId, ctx.from?.username || "unknown", "PLAN_EDIT", message, response);
    } catch (error) {
      console.error("Error in plan feedback:", error);
      await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
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
      const keyboard = createAskUserQuestionKeyboard(nextQ, requestId, pending.currentIndex, pending.questions.length);
      await ctx.reply(questionText, { reply_markup: keyboard, parse_mode: "HTML" });
    } else {
      // All questions answered - send to Claude
      pendingAskUserQuestions.delete(requestId);
      const answersText = pending.answers.join(", ");
      await ctx.reply(`✅ Answered: ${answersText}`);

      // Send answers to Claude
      const typing = startTypingIndicator(ctx);
      const state = new StreamingState();
      const statusCallback = createStatusCallback(ctx, state);

      try {
        const response = await session.sendMessageStreaming(
          answersText,
          username,
          userId,
          statusCallback,
          chatId,
          ctx
        );
        await auditLog(userId, username, "AUQ_CUSTOM", message, response);
      } catch (error) {
        console.error("Error in AskUserQuestion custom answer:", error);
        await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
      } finally {
        typing.stop();
      }
    }
    return;
  }

  // 2. Check for interrupt prefix
  message = await checkInterrupt(message);
  if (!message.trim()) {
    return;
  }

  // 3. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
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

  // 7. Sync with registry if no session loaded
  if (!session.sessionName) {
    const active = await getActiveSession();
    if (active) {
      session.loadFromRegistry(active.info);
    }
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
        ctx
      );

      console.log(`[TEXT] Response: "${response?.slice(0, 100)}..."`);

      // 12. Audit log
      await auditLog(userId, username, "TEXT", message, response);
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
        console.log(
          `Claude Code crashed, retrying (attempt ${attempt + 2}/${MAX_RETRIES + 1})...`
        );
        await session.kill(); // Clear corrupted session
        await ctx.reply(`⚠️ Claude crashed, retrying...`);
        // Reset state for retry
        state = new StreamingState();
        statusCallback = createStatusCallback(ctx, state);
        continue;
      }

      // Final attempt failed or non-retryable error
      console.error("Error processing message:", error);

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

  // 13. Cleanup
  stopProcessing();
  typing.stop();
}
