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
import {
  createOpId,
  debug,
  elapsedMs,
  error as logError,
  info,
  warn,
  truncate,
} from "../logger";
import { sendViaRelay } from "./relay-bridge";
import { isAbsolute } from "path";
import { stat } from "fs/promises";
import { pendingSettingsInput } from "./settings";
import { saveSetting } from "../settings";
import { escapeHtml } from "../formatting";

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

  const opId = createOpId("text");
  const requestStartedAt = Date.now();
  info("request: started", {
    opId,
    requestKind: "text",
    chatId,
    userId,
    username,
    messagePreview: truncate(message, 120),
  });

  // 1.4. Check for pending settings input (working dir entry)
  if (pendingSettingsInput.has(chatId)) {
    const field = pendingSettingsInput.get(chatId)!;
    if (message.trim() === "/cancel") {
      pendingSettingsInput.delete(chatId);
      await ctx.reply("✖ Cancelled.");
      return;
    }
    if (field === "workdir") {
      const path = message.trim();
      if (!isAbsolute(path)) {
        await ctx.reply("❌ Path must be absolute (start with /).");
        return;
      }
      try {
        const s = await stat(path);
        if (!s.isDirectory()) {
          await ctx.reply("❌ Not a directory.");
          return;
        }
      } catch {
        await ctx.reply("❌ Path does not exist.");
        return;
      }
      await saveSetting({ workingDir: path });
      pendingSettingsInput.delete(chatId);
      await ctx.reply(`✅ Working dir set:\n<code>${escapeHtml(path)}</code>`, {
        parse_mode: "HTML",
      });
      return;
    }
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
        {
          opId,
          requestKind: "plan_edit",
        },
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
      info("request: completed", {
        opId,
        requestKind: "plan_edit",
        chatId,
        userId,
        durationMs: elapsedMs(requestStartedAt),
        path: "plan_edit",
      });
    } catch (err) {
      logError("request: failed", err, {
        opId,
        requestKind: "plan_edit",
        chatId,
        userId,
        durationMs: elapsedMs(requestStartedAt),
      });
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
          {
            opId,
            requestKind: wasPlanMode
              ? "ask_user_custom_plan"
              : "ask_user_custom",
          },
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
        info("request: completed", {
          opId,
          requestKind: wasPlanMode ? "ask_user_custom_plan" : "ask_user_custom",
          chatId,
          userId,
          durationMs: elapsedMs(requestStartedAt),
          path: "sdk",
        });
      } catch (err) {
        logError("request: failed", err, {
          opId,
          requestKind: wasPlanMode ? "ask_user_custom_plan" : "ask_user_custom",
          chatId,
          userId,
          durationMs: elapsedMs(requestStartedAt),
        });
        await ctx.reply(`❌ Error: ${String(err).slice(0, 200)}`);
      } finally {
        typing.stop();
      }
    }
    return;
  }

  // 1.7. Check for active watch — relay message to desktop session.
  if (isWatching(chatId)) {
    const relayed = await sendWatchRelay(chatId, username, message, opId);
    if (relayed) {
      ctx.replyWithChatAction("typing").catch(() => {});
      await auditLog(userId, username, "WATCH_RELAY", message, "(via relay)");
      info("request: completed", {
        opId,
        requestKind: "text",
        chatId,
        userId,
        durationMs: elapsedMs(requestStartedAt),
        path: "watch_relay",
      });
      return;
    }

    // Relay failed — session may be offline
    warn("request: watch relay unavailable", {
      opId,
      requestKind: "text",
      chatId,
      userId,
      durationMs: elapsedMs(requestStartedAt),
    });
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
    info("request: completed", {
      opId,
      requestKind: "text",
      chatId,
      userId,
      durationMs: elapsedMs(requestStartedAt),
      path: "clear",
    });
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
  // Slash commands must run locally via the SDK (for <local-command-stdout> handling),
  // not forwarded to a relay target that would treat them as plain text.
  if (!message.startsWith("/")) {
    const relayResult = await sendViaRelay(
      ctx,
      message,
      username,
      chatId,
      undefined,
      opId,
    );
    if (relayResult === "delivered") {
      await auditLog(userId, username, "RELAY", message, "(via relay)");
      info("request: completed", {
        opId,
        requestKind: "text",
        chatId,
        userId,
        durationMs: elapsedMs(requestStartedAt),
        path: "relay",
      });
      return;
    }

    warn("request: relay " + relayResult, {
      opId,
      requestKind: "text",
      chatId,
      userId,
      durationMs: elapsedMs(requestStartedAt),
    });
    if (relayResult === "failed") {
      await ctx.reply(
        "⚠️ Message was sent but the session stopped responding.\n" +
          "It may still be processing. Check /status or try again.",
      );
    } else {
      await ctx.reply(
        "❌ No desktop session found.\n\n" +
          "Use /new to spawn one, or /list to find existing sessions.",
      );
    }
    return;
  }

  // 8. Slash command — run locally via SDK so <local-command-stdout> is handled
  const typing = startTypingIndicator(ctx);
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);
  try {
    const response = await session.sendMessageStreaming(
      message,
      username,
      userId!,
      statusCallback,
      chatId!,
      ctx,
      "bypassPermissions",
      { opId, requestKind: "slash_cmd" },
    );
    await auditLog(
      userId,
      username,
      "SLASH_CMD",
      message,
      response || "(done)",
    );
    info("request: completed", {
      opId,
      requestKind: "slash_cmd",
      chatId,
      userId,
      durationMs: elapsedMs(requestStartedAt),
      path: "local_sdk",
    });
  } catch (err) {
    logError("slash cmd error", err);
    await ctx.reply(
      `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    typing.stop();
  }
}
