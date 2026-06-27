/**
 * Text message handler for Claude Telegram Bot.
 */

import type { Context } from "grammy";
import {
  runQueryStreaming,
  runPlanApproval,
  getCurrentModel,
} from "../session";
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
  pendingKey,
} from "./streaming";
import { getSessionState } from "../sessions/session-state";
import type { SessionContext } from "../sessions/context";
import { pendingPlanFeedback } from "./callback";
import { tryConsumeCustomTextAnswer } from "./relay-ask";
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
import { isTopicChat } from "./commands";
import { isGeneralTopic, isSessionTopic } from "../topics";
import { getSession } from "../sessions";
import { escapeHtml } from "../formatting";
import { globalEventBus } from "../web/sse";
import { getMessageBus } from "../messaging";
import { markReceived } from "./reactions";

/**
 * Bus-routed reply helper. Use for plain or HTML text replies including
 * thread-routed sends and inline keyboards. Callers stay on grammy directly
 * when they need link_preview_options or other TG-specific options the bus
 * doesn't model.
 */
function busReply(
  ctx: Context,
  content: string,
  opts: {
    format?: "plain" | "html";
    threadId?: number;
    replyMarkup?: import("grammy/types").InlineKeyboardMarkup;
  } = {},
): Promise<unknown> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return Promise.resolve();
  return getMessageBus().send({
    chatId,
    threadId: opts.threadId ?? ctx.message?.message_thread_id,
    content,
    format: opts.format ?? "plain",
    replyMarkup: opts.replyMarkup,
  });
}

/**
 * Handle incoming text messages.
 */
export async function handleText(
  ctx: Context,
  sctx?: SessionContext,
  textOverride?: string,
): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  let message = textOverride ?? ctx.message?.text;

  if (!userId || !message || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 1.05. ask_remote custom-text capture (relay bridge two-way).
  // Runs before topic gating so a question delivered without a thread_id
  // (i.e. landed in General) can still be answered. Keyed by (chat, thread)
  // so sibling topics in a forum chat don't have their input hijacked by
  // an open ask_remote in another topic. The text is consumed here — never
  // forwarded into the Claude session as a fresh prompt.
  const incomingThreadId = ctx.message?.message_thread_id;
  // Composite key for pending-input maps — (chatId, threadId) so forum topics
  // don't hijack each other's pending replies.
  const incomingPendingKey = pendingKey(chatId, incomingThreadId);
  if (tryConsumeCustomTextAnswer(chatId, incomingThreadId, message)) {
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

  // Stage-aware reactions — instant 👀 receipt so the user sees the bot
  // noticed their message. Promoted to 🤔 by event-router on first tool/text
  // event and to 🎉 on turn_end. If the message bails before reaching CC,
  // the 👀 honestly stays put.
  const inboundMessageId = ctx.message?.message_id;
  if (inboundMessageId !== undefined) {
    markReceived(ctx.api, chatId, incomingThreadId, inboundMessageId);
  }

  // Topic routing — use the explicit SessionContext the caller resolved.
  // Falls back to the General-topic nudge when no context (private chats,
  // General topic, or unbound session topic).
  let threadId: number | undefined = sctx?.topicId;
  let cursorSessionName: string | undefined;
  // Per-session state resolved from sctx. Undefined for cursor / no-sctx
  // paths; CC handlers use this in place of the singleton (task 7c).
  const state =
    sctx && sctx.source === "cc"
      ? getSessionState(sctx.sessionName)
      : undefined;

  if (sctx) {
    if (sctx.source === "cursor") {
      // Cursor sessions don't have a Claude SDK relay; the CursorBridge
      // delivers via the event bus directly into Cursor's Composer.
      cursorSessionName = sctx.sessionName;
    } else {
      // CC session — sync the per-session SessionState with the registry so
      // sessionId/cwd/lastActivity reflect the latest watcher snapshot.
      const si = getSession(sctx.sessionName);
      if (si && state) state.loadFromRegistry(si);
    }
  } else if (isTopicChat(ctx) && isGeneralTopic(ctx)) {
    // Free text in General — nudge to use a topic.
    // Allow through if there are pending interactive states.
    const incomingPendingKey = pendingKey(chatId, incomingThreadId);
    if (
      !pendingSettingsInput.has(incomingPendingKey) &&
      !pendingPlanFeedback.has(incomingPendingKey) &&
      !pendingAskUserQuestionCustom.has(incomingPendingKey)
    ) {
      await busReply(
        ctx,
        "❌ Send messages in a session topic.\nUse /list to see sessions.",
      );
      return;
    }
  }

  // 1.4. Check for pending settings input (working dir entry)
  const _settingsPK = pendingKey(chatId, incomingThreadId);
  if (pendingSettingsInput.has(_settingsPK)) {
    const field = pendingSettingsInput.get(_settingsPK)!;
    if (message.trim() === "/cancel") {
      pendingSettingsInput.delete(_settingsPK);
      await busReply(ctx, "✖ Cancelled.", { threadId });
      return;
    }
    if (field === "workdir") {
      const path = message.trim();
      if (!isAbsolute(path)) {
        await busReply(ctx, "❌ Path must be absolute (start with /).", {
          threadId,
        });
        return;
      }
      try {
        const s = await stat(path);
        if (!s.isDirectory()) {
          await busReply(ctx, "❌ Not a directory.", { threadId });
          return;
        }
      } catch {
        await busReply(ctx, "❌ Path does not exist.", { threadId });
        return;
      }
      await saveSetting({ workingDir: path });
      pendingSettingsInput.delete(_settingsPK);
      await busReply(
        ctx,
        `✅ Working dir set:\n<code>${escapeHtml(path)}</code>`,
        { format: "html", threadId },
      );
      return;
    }
  }

  // 1.5. Check for pending plan feedback
  const _planPK = pendingKey(chatId, incomingThreadId);
  if (pendingPlanFeedback.has(_planPK)) {
    const requestId = pendingPlanFeedback.get(_planPK)!;
    pendingPlanFeedback.delete(_planPK);

    // Plan-edit replies only make sense against a resolved per-session
    // SessionState. Without sctx (private DM / General topic) there's no
    // session to apply the edit to.
    const pendingApproval = state?.pendingPlanApproval;
    if (!pendingApproval) {
      await busReply(ctx, "❌ Plan approval expired.", { threadId });
      return;
    }

    // Process feedback
    const typing = startTypingIndicator(ctx);
    const streamState = new StreamingState();
    const statusCallback = createStatusCallback(ctx, streamState, threadId);

    try {
      const response = await runPlanApproval(state, {
        action: "edit",
        feedback: message,
        username: ctx.from?.username || "unknown",
        userId,
        statusCallback,
        chatId,
        ctx,
        telemetry: { opId, requestKind: "plan_edit" },
        model: getCurrentModel(),
      });

      // Check if another plan approval is pending
      const nextPending = state.pendingPlanApproval;
      if (nextPending) {
        const newRequestId = `${Date.now()}`;
        const keyboard = createPlanApprovalKeyboard(newRequestId);
        await busReply(ctx, "📋 Revised plan ready. Review and approve?", {
          replyMarkup: keyboard,
          threadId,
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
      await busReply(ctx, `❌ Error: ${String(err).slice(0, 200)}`, {
        threadId,
      });
    } finally {
      typing.stop();
    }
    return;
  }

  // 1.6. Check for pending AskUserQuestion custom input
  const _customPK = pendingKey(chatId, incomingThreadId);
  if (pendingAskUserQuestionCustom.has(_customPK)) {
    const requestId = pendingAskUserQuestionCustom.get(_customPK)!;
    pendingAskUserQuestionCustom.delete(_customPK);

    const pending = pendingAskUserQuestions.get(requestId);
    if (!pending) {
      await busReply(ctx, "❌ Question expired.", { threadId });
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
      await busReply(ctx, questionText, {
        replyMarkup: keyboard,
        format: "html",
        threadId,
      });
    } else {
      // All questions answered - send to Claude
      const wasPlanMode = pending.isPlanMode;
      pendingAskUserQuestions.delete(requestId);
      const answersText = pending.answers.join(", ");
      await busReply(ctx, `✅ Answered: ${answersText}`, { threadId });

      // Send answers to Claude (preserve plan mode)
      const typing = startTypingIndicator(ctx);
      const streamState = new StreamingState();
      const statusCallback = createStatusCallback(ctx, streamState, threadId);

      try {
        const permissionMode = wasPlanMode ? "plan" : "bypassPermissions";
        if (!state) {
          await busReply(ctx, "❌ Question expired — no session.", {
            threadId,
          });
          return;
        }
        const response = await runQueryStreaming(state, {
          message: answersText,
          username,
          userId,
          statusCallback,
          chatId,
          ctx,
          permissionMode,
          telemetry: {
            opId,
            requestKind: wasPlanMode
              ? "ask_user_custom_plan"
              : "ask_user_custom",
          },
          model: getCurrentModel(),
        });
        await auditLog(userId, username, "AUQ_CUSTOM", message, response);

        // Check if plan approval is pending (ExitPlanMode was called)
        const pendingForKeyboard = state.pendingPlanApproval;
        if (pendingForKeyboard) {
          const displayContent =
            pendingForKeyboard.planContent || pendingForKeyboard.planSummary;
          if (displayContent && displayContent.length > 50) {
            await sendPlanContent(ctx, displayContent);
          }

          const keyboard = createPlanApprovalKeyboard(`${Date.now()}`);
          await busReply(ctx, "Review and approve?", {
            replyMarkup: keyboard,
            threadId,
          });
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
        await busReply(ctx, `❌ Error: ${String(err).slice(0, 200)}`, {
          threadId,
        });
      } finally {
        typing.stop();
      }
    }
    return;
  }

  // 1.65. Cursor topic — emit to bus and return. The CursorBridge subscribes
  // to the bus and injects the message into Cursor's Composer. Must run
  // before the watch-relay check below, since cursor sessions have no TCP
  // relay; the watch path would always fail with "Relay failed".
  if (cursorSessionName) {
    globalEventBus.emit(cursorSessionName, {
      type: "user_message",
      source: "telegram",
      content: message,
    });
    ctx
      .replyWithChatAction("typing", { message_thread_id: threadId })
      .catch(() => {});
    await auditLog(userId, username, "CURSOR_RELAY", message, "(via bus)");
    info("request: completed", {
      opId,
      requestKind: "text",
      chatId,
      userId,
      durationMs: elapsedMs(requestStartedAt),
      path: "cursor_bus",
    });
    return;
  }

  // 1.7. Check for active watch — relay message to desktop session.
  // In topic mode, pass session override so the relay targets the correct session
  // (topic routing loaded the right session above, but the watch may point elsewhere).
  if (threadId !== undefined && isWatching(chatId, threadId)) {
    const relayed = await sendWatchRelay(
      chatId,
      threadId,
      username,
      message,
      opId,
      undefined,
      sctx,
    );
    if (relayed) {
      const topicCtx = isSessionTopic(ctx);
      const busKey = topicCtx?.sessionName ?? String(chatId);
      globalEventBus.emit(busKey, {
        type: "user_message",
        source: "telegram",
        content: message,
      });
      ctx
        .replyWithChatAction("typing", { message_thread_id: threadId })
        .catch(() => {});
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
    await busReply(
      ctx,
      "❌ Relay failed. Session may be offline.\n" +
        "Use /unwatch and check /list.",
      { threadId },
    );
    return;
  }

  // 2. Check for interrupt prefix — write/read the flag on this topic's
  // per-session SessionState when available, else the legacy singleton.
  message = await checkInterrupt(message, state);
  if (!message.trim()) {
    await busReply(ctx, "✖ Empty message after interrupt — nothing to send.", {
      threadId,
    }).catch(() => {});
    return;
  }

  // 3. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await busReply(
      ctx,
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`,
      { threadId },
    );
    return;
  }

  // 4. Handle /clear locally (SDK doesn't support it)
  if (message.trim() === "/clear") {
    // The desktop session's new id after /clear is re-anchored into the topic
    // store by the watcher (topicSessionIdRefreshPlan) from the live port file.
    // The previous attempt to clear it here was a no-op anyway — updateTopicMapping
    // skips `undefined` and guards against wiping a stored sessionId.
    if (state) {
      state.clearSession();
    }
    await busReply(ctx, "✓ Session cleared", { threadId });
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

  // 5. Store message for retry on the per-session SessionState (when present).
  // No-sctx paths have no session to record against — retry won't work there.
  if (state) {
    state.lastMessage = message;
  }

  // Debug log incoming message
  debug(`msg: "${truncate(message)}"`);

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
      threadId,
      sctx,
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
      await busReply(
        ctx,
        "⚠️ Message was sent but the session stopped responding.\n" +
          "It may still be processing. Check /status or try again.",
        { threadId },
      );
    } else {
      await busReply(
        ctx,
        "❌ No desktop session found.\n\n" +
          "Use /new to spawn one, or /list to find existing sessions.",
        { threadId },
      );
    }
    return;
  }

  // 8. Slash command — run locally via SDK so <local-command-stdout> is handled.
  // Task 7c: slash commands require a resolved CC SessionState. With no sctx
  // (General topic / private DM), reply with "no desktop session" instead of
  // running locally against the singleton — that fallback was the bug being
  // fixed by Phase 1.
  if (!state) {
    await busReply(
      ctx,
      "❌ No desktop session found.\n\n" +
        "Use /new to spawn one, or /list to find existing sessions.",
      { threadId },
    );
    return;
  }

  const typing = startTypingIndicator(ctx);
  const streamState = new StreamingState();
  const statusCallback = createStatusCallback(ctx, streamState, threadId);
  try {
    const response = await runQueryStreaming(state, {
      message,
      username,
      userId: userId!,
      statusCallback,
      chatId: chatId!,
      ctx,
      permissionMode: "bypassPermissions",
      telemetry: { opId, requestKind: "slash_cmd" },
      model: getCurrentModel(),
    });
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
    await busReply(
      ctx,
      `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
      { threadId },
    );
  } finally {
    typing.stop();
  }
}
