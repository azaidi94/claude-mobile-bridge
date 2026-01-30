/**
 * Callback query handler for Claude Telegram Bot.
 *
 * Handles inline keyboard button presses (ask_user MCP integration, plan approval).
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { session, MODEL_DISPLAY_NAMES, type ModelId } from "../session";
import { ALLOWED_USERS } from "../config";
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
} from "../sessions";

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
      console.log(
        `[MODEL SWITCH] Sending /model ${modelId} to session ${session.sessionId?.slice(0, 8)}`,
      );
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
        console.error("[MODEL SWITCH] Failed to send /model command:", error);
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
    updatePinnedStatus(ctx.api, chatId, {
      sessionName: active?.name || null,
      isPlanMode: session.isPlanMode,
      model: session.modelDisplayName,
    }).catch(() => {});
    return;
  }

  // 3. Handle switch callbacks: switch:{session_name}
  if (callbackData.startsWith("switch:")) {
    const name = callbackData.slice(7); // Remove "switch:" prefix
    const currentActive = getActiveSession();

    // Already on this session
    if (currentActive?.name === name) {
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
        const lines: string[] = ["📋 <b>Sessions</b>\n"];

        for (const s of sessions) {
          const isActive = active.name === s.name;
          const marker = isActive ? "✅ " : "• ";
          const dir = s.dir.replace(/^\/Users\/[^/]+/, "~");
          const ago = formatTimeAgo(s.lastActivity);
          lines.push(
            `${marker}<code>${s.name}</code>`,
            `   ${dir}`,
            `   ${ago}`,
          );
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

        // Update pinned status with new session
        updatePinnedStatus(ctx.api, chatId, {
          sessionName: active.name,
          isPlanMode: session.isPlanMode,
          model: session.modelDisplayName,
        }).catch(() => {});
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
      console.error("Error in plan approval:", error);
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
        console.error("Error in AskUserQuestion skip:", error);
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
          console.error("Error in AskUserQuestion answer:", error);
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
    console.error(`Failed to load ask-user request ${requestId}:`, error);
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
    console.debug("Failed to edit callback message:", error);
  }

  // 10. Answer the callback
  await ctx.answerCallbackQuery({
    text: `Selected: ${selectedOption.slice(0, 50)}`,
  });

  // 11. Delete request file
  try {
    unlinkSync(requestFile);
  } catch (error) {
    console.debug("Failed to delete request file:", error);
  }

  // 12. Send the choice to Claude as a message
  const message = selectedOption;

  // Interrupt any running query - button responses are always immediate
  if (session.isRunning) {
    console.log("Interrupting current query for button response");
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
    console.error("Error processing callback:", error);

    for (const toolMsg of state.toolMessages) {
      try {
        await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
      } catch (error) {
        console.debug("Failed to delete tool message:", error);
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

// Helper
function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}
