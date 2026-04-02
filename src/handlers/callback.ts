/**
 * Callback query handler for Claude Telegram Bot.
 *
 * Handles inline keyboard button presses (ask_user MCP integration, plan approval).
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { session, MODEL_DISPLAY_NAMES, type ModelId } from "../session";
import { ALLOWED_USERS } from "../config";
import { formatTimeAgo } from "../formatting";
import { isAuthorized } from "../security";
import { auditLog, startTypingIndicator } from "../utils";
import {
  StreamingState,
  createStatusCallback,
  createPlanApprovalKeyboard,
  createAskUserQuestionKeyboard,
  pendingAskUserQuestions,
  pendingAskUserQuestionCustom,
  sendPlanContent,
} from "./streaming";
import {
  setActiveSession,
  getActiveSession,
  getSessions,
  updatePinnedStatus,
  getGitBranch,
  sendSwitchHistory,
} from "../sessions";
import { startWatchingAndNotify, isWatching } from "./watch";
import { escapeHtml } from "../formatting";
import { debug, error as logError, info } from "../logger";

// Track pending plan feedback by chat ID (exported for text.ts)
export const pendingPlanFeedback = new Map<number, string>(); // chatId -> requestId

/**
 * Handle callback queries from inline keyboards.
 */
export async function handleCallback(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const callbackData = ctx.callbackQuery?.data;

  if (!userId || !chatId || !callbackData) {
    await ctx.answerCallbackQuery();
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.answerCallbackQuery({ text: "Unauthorized" });
    return;
  }

  // 2. Handle model switch callbacks: model:{model_id}
  if (callbackData.startsWith("model:")) {
    const modelId = callbackData.slice(6) as ModelId; // Remove "model:" prefix

    if (!(modelId in MODEL_DISPLAY_NAMES)) {
      await ctx.answerCallbackQuery({ text: "Invalid model" });
      return;
    }

    // Already on this model
    if (session.model === modelId) {
      await ctx.answerCallbackQuery({
        text: `Already using ${MODEL_DISPLAY_NAMES[modelId]}`,
      });
      return;
    }

    session.setModel(modelId);

    // Send /model command to Claude session to switch model mid-session
    if (session.isActive) {
      info("model: syncing switch to Claude", {
        chatId,
        userId,
        modelId,
        sessionId: session.sessionId,
      });
      try {
        await session.sendMessageStreaming(
          `/model ${modelId}`,
          username,
          userId,
          async () => {}, // Silent - no status updates
          chatId,
          ctx,
        );
      } catch (error) {
        logError("model: failed to sync switch", error, {
          chatId,
          userId,
          modelId,
          sessionId: session.sessionId,
        });
      }
    }

    // Update message with new selection
    const models = Object.entries(MODEL_DISPLAY_NAMES) as [ModelId, string][];
    const buttons = models.map(([id, name]) => [
      {
        text: id === modelId ? `✓ ${name}` : name,
        callback_data: `model:${id}`,
      },
    ]);

    await ctx.editMessageText(
      `🤖 <b>Model:</b> ${MODEL_DISPLAY_NAMES[modelId]}`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons },
      },
    );
    await ctx.answerCallbackQuery({
      text: `Switched to ${MODEL_DISPLAY_NAMES[modelId]}`,
    });

    // Update pinned status with new model
    const active = getActiveSession();
    getGitBranch(session.workingDir)
      .then((branch) =>
        updatePinnedStatus(ctx.api, chatId, {
          sessionName: active?.name || null,
          isPlanMode: session.isPlanMode,
          model: session.modelDisplayName,
          branch,
        }),
      )
      .catch(() => {});
    return;
  }

  // 3. Handle switch callbacks: switch:{session_name}
  if (callbackData.startsWith("switch:")) {
    const name = callbackData.slice(7); // Remove "switch:" prefix
    const currentActive = getActiveSession();

    // Already on this session — start watching if not already
    if (currentActive?.name === name) {
      if (currentActive.info.source === "desktop" && !isWatching(chatId)) {
        if (await startWatchingAndNotify(ctx, chatId, name, "switch")) {
          await ctx.answerCallbackQuery({ text: `Watching ${name}` });
          return;
        }
      }
      await ctx.answerCallbackQuery({ text: `Already on ${name}` });
      return;
    }

    const success = setActiveSession(name);

    if (success) {
      const active = getActiveSession();
      if (active) {
        session.loadFromRegistry(active.info);

        // Rebuild session list with updated active marker
        const sessions = getSessions();
        const branches = await Promise.all(
          sessions.map((s) => getGitBranch(s.dir)),
        );
        const lines: string[] = ["📋 <b>Sessions</b>\n"];

        for (let i = 0; i < sessions.length; i++) {
          const s = sessions[i]!;
          const isActive = active.name === s.name;
          const marker = isActive ? "✅ " : "• ";
          const dir = s.dir.replace(/^\/Users\/[^/]+/, "~");
          const ago = formatTimeAgo(s.lastActivity);
          const branch = branches[i];

          const meta = [dir, branch ? `🌿 ${branch}` : null, ago]
            .filter(Boolean)
            .join(" · ");
          lines.push(`${marker}<b>${s.name}</b>`, `   ${meta}`, "");
        }

        // Rebuild buttons with updated checkmark
        const buttons = sessions.map((s) => [
          {
            text: active.name === s.name ? `✓ ${s.name}` : s.name,
            callback_data: `switch:${s.name}`,
          },
        ]);

        await ctx.editMessageText(lines.join("\n"), {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: buttons },
        });
        await ctx.answerCallbackQuery({ text: `Switched to ${name}` });

        await sendSwitchHistory(ctx, active.info);

        // Auto-watch desktop sessions
        if (active.info.source === "desktop") {
          await startWatchingAndNotify(ctx, chatId, active.name, "switch");
        } else {
          // Update pinned status for non-desktop sessions
          getGitBranch(active.info.dir)
            .then((branch) =>
              updatePinnedStatus(ctx.api, chatId, {
                sessionName: active.name,
                isPlanMode: session.isPlanMode,
                model: session.modelDisplayName,
                branch,
              }),
            )
            .catch(() => {});
        }
      }
    } else {
      await ctx.answerCallbackQuery({ text: "Session not found" });
    }
    return;
  }

  // 4. Handle plan approval callbacks: plan:{action}:{request_id}
  if (callbackData.startsWith("plan:")) {
    const parts = callbackData.split(":");
    if (parts.length !== 3) {
      await ctx.answerCallbackQuery({ text: "Invalid callback" });
      return;
    }

    const action = parts[1] as "accept" | "reject" | "edit";
    const requestId = parts[2]!;

    // Check if there's a pending plan approval
    if (!session.pendingPlanApproval) {
      await ctx.answerCallbackQuery({ text: "No pending plan" });
      return;
    }

    if (action === "edit") {
      // Store pending feedback state
      pendingPlanFeedback.set(chatId, requestId);
      await ctx.editMessageText("✏️ Reply with your feedback for the plan:");
      await ctx.answerCallbackQuery({ text: "Send your feedback" });
      return;
    }

    // Accept or Reject
    await ctx.editMessageText(
      action === "accept" ? "✅ Plan accepted" : "❌ Plan rejected",
    );
    await ctx.answerCallbackQuery({
      text: action === "accept" ? "Accepted" : "Rejected",
    });

    // Start typing
    const typing = startTypingIndicator(ctx);
    const state = new StreamingState();
    const statusCallback = createStatusCallback(ctx, state);

    try {
      const feedback = action === "reject" ? "User rejected the plan." : "";
      const response = await session.respondToPlanApproval(
        action,
        feedback,
        username,
        userId,
        statusCallback,
        chatId,
        ctx,
      );

      // Check if another plan approval is pending (for reject flow)
      if (session.pendingPlanApproval) {
        const newRequestId = `${Date.now()}`;
        const keyboard = createPlanApprovalKeyboard(newRequestId);
        await ctx.reply("📋 Revised plan ready. Review and approve?", {
          reply_markup: keyboard,
        });
      }

      await auditLog(
        userId,
        username,
        "PLAN_" + action.toUpperCase(),
        "",
        response,
      );
    } catch (error) {
      logError("callback: plan approval failed", error, {
        chatId,
        userId,
        username,
        action,
      });
      await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
    } finally {
      typing.stop();
    }
    return;
  }

  // 5. Handle AskUserQuestion callbacks: auq:{requestId}:{action}:{optionIdx?}
  if (callbackData.startsWith("auq:")) {
    const parts = callbackData.split(":");
    if (parts.length < 3) {
      await ctx.answerCallbackQuery({ text: "Invalid callback" });
      return;
    }

    const requestId = parts[1]!;
    const action = parts[2]!; // "opt", "custom", "skip"
    const optionIdx =
      parts[3] !== undefined ? parseInt(parts[3]!, 10) : undefined;

    const pending = pendingAskUserQuestions.get(requestId);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Expired" });
      return;
    }

    if (action === "skip") {
      // Skip all - send generic response to Claude
      pendingAskUserQuestions.delete(requestId);
      await ctx.editMessageText("⏭️ Skipped questions");
      await ctx.answerCallbackQuery();

      // Send skip message to Claude
      const typing = startTypingIndicator(ctx);
      const state = new StreamingState();
      const statusCallback = createStatusCallback(ctx, state);

      try {
        const response = await session.sendMessageStreaming(
          "Skip questions, proceed with the plan",
          username,
          userId,
          statusCallback,
          chatId,
          ctx,
        );
        await auditLog(userId, username, "AUQ_SKIP", "skip", response);
      } catch (error) {
        logError("callback: ask-user skip failed", error, {
          chatId,
          userId,
          username,
          requestId,
        });
        await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
      } finally {
        typing.stop();
      }
      return;
    }

    if (action === "custom") {
      // Store pending custom input
      pendingAskUserQuestionCustom.set(chatId, requestId);
      const currentQ = pending.questions[pending.currentIndex]!;
      await ctx.editMessageText(
        `✏️ Type your answer:\n\n<i>${currentQ.question}</i>`,
        { parse_mode: "HTML" },
      );
      await ctx.answerCallbackQuery({ text: "Type your answer" });
      return;
    }

    // Option selected
    if (action === "opt" && optionIdx !== undefined) {
      const currentQ = pending.questions[pending.currentIndex]!;
      if (optionIdx < 0 || optionIdx >= currentQ.options.length) {
        await ctx.answerCallbackQuery({ text: "Invalid option" });
        return;
      }

      const selectedOption = currentQ.options[optionIdx]!.label;
      pending.answers.push(selectedOption);
      pending.currentIndex++;

      await ctx.answerCallbackQuery({
        text: `Selected: ${selectedOption.slice(0, 30)}`,
      });

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
        await ctx.editMessageText(questionText, {
          reply_markup: keyboard,
          parse_mode: "HTML",
        });
      } else {
        // All questions answered - send to Claude
        const wasPlanMode = pending.isPlanMode;
        pendingAskUserQuestions.delete(requestId);
        const answersText = pending.answers.join(", ");
        await ctx.editMessageText(`✅ Answered: ${answersText}`);

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
          await auditLog(userId, username, "AUQ_ANSWER", answersText, response);

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
        } catch (error) {
          logError("callback: ask-user answer failed", error, {
            chatId,
            userId,
            username,
            requestId,
          });
          await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
        } finally {
          typing.stop();
        }
      }
      return;
    }

    await ctx.answerCallbackQuery({ text: "Unknown action" });
    return;
  }

  // 6. Parse callback data: askuser:{request_id}:{option_index}
  if (!callbackData.startsWith("askuser:")) {
    await ctx.answerCallbackQuery();
    return;
  }

  const parts = callbackData.split(":");
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const requestId = parts[1]!;
  const optionIndex = parseInt(parts[2]!, 10);

  // 7. Load request file
  const requestFile = `/tmp/ask-user-${requestId}.json`;
  let requestData: {
    question: string;
    options: string[];
    status: string;
  };

  try {
    const file = Bun.file(requestFile);
    const text = await file.text();
    requestData = JSON.parse(text);
  } catch (error) {
    logError("callback: failed to load ask-user request", error, {
      chatId,
      requestId,
      requestFile,
    });
    await ctx.answerCallbackQuery({ text: "Request expired or invalid" });
    return;
  }

  // 8. Get selected option
  if (optionIndex < 0 || optionIndex >= requestData.options.length) {
    await ctx.answerCallbackQuery({ text: "Invalid option" });
    return;
  }

  const selectedOption = requestData.options[optionIndex]!;

  // 9. Update the message to show selection
  try {
    await ctx.editMessageText(`✓ ${selectedOption}`);
  } catch (error) {
    debug("callback: failed to edit confirmation message", {
      chatId,
      requestId,
      err: String(error),
    });
  }

  // 10. Answer the callback
  await ctx.answerCallbackQuery({
    text: `Selected: ${selectedOption.slice(0, 50)}`,
  });

  // 11. Delete request file
  try {
    unlinkSync(requestFile);
  } catch (error) {
    debug("callback: failed to delete request file", {
      requestId,
      requestFile,
      err: String(error),
    });
  }

  // 12. Send the choice to Claude as a message
  const message = selectedOption;

  // Interrupt any running query - button responses are always immediate
  if (session.isRunning) {
    info("callback: interrupting current query for response", {
      chatId,
      userId,
      requestId,
    });
    await session.stop();
    // Small delay to ensure clean interruption
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Start typing
  const typing = startTypingIndicator(ctx);

  // Create streaming state
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    const response = await session.sendMessageStreaming(
      message,
      username,
      userId,
      statusCallback,
      chatId,
      ctx,
    );

    await auditLog(userId, username, "CALLBACK", message, response);
  } catch (error) {
    logError("callback: processing failed", error, {
      chatId,
      userId,
      username,
      requestId,
    });

    for (const toolMsg of state.toolMessages) {
      try {
        await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
      } catch (error) {
        debug("callback: failed to delete tool message", {
          chatId: toolMsg.chat.id,
          messageId: toolMsg.message_id,
          err: String(error),
        });
      }
    }

    if (String(error).includes("abort") || String(error).includes("cancel")) {
      // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
      const wasInterrupt = session.consumeInterruptFlag();
      if (!wasInterrupt) {
        await ctx.reply("🛑 Query stopped.");
      }
    } else {
      await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
    }
  } finally {
    typing.stop();
  }
}
