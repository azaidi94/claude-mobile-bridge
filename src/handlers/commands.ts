/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /help, /new, /stop, /status, /restart, /retry
 * /list, /switch
 */

import type { Context } from "grammy";
import { session, MODEL_DISPLAY_NAMES, type ModelId } from "../session";
import { WORKING_DIR, ALLOWED_USERS, RESTART_FILE } from "../config";
import { formatTimeAgo } from "../formatting";
import { isAuthorized, rateLimiter } from "../security";
import {
  getSessions,
  getActiveSession,
  setActiveSession,
  addTelegramSession,
  forceRefresh,
  removeSession,
  updatePinnedStatus,
  getGitBranch,
  getRecentHistory,
  formatHistoryMessage,
} from "../sessions";
import { auditLog, auditLogRateLimit, startTypingIndicator } from "../utils";
import {
  StreamingState,
  createStatusCallback,
  createPlanApprovalKeyboard,
  sendPlanContent,
} from "./streaming";
import { TaskQueue, parseTasks, getActiveQueue } from "../queue";

/**
 * /start - Show welcome message and status.
 */
export async function handleStart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  const activeSession = getActiveSession();
  const sessionName = activeSession?.name || "none";

  await ctx.reply(
    `🤖 <b>Claude Coding Bot</b>\n\n` +
      `Active: <code>${sessionName}</code>\n\n` +
      `Use /help for commands`,
    { parse_mode: "HTML" },
  );
}

/**
 * /help - Show detailed help.
 */
export async function handleHelp(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  await ctx.reply(
    `📚 <b>Commands</b>\n\n` +
      `<b>Sessions:</b>\n` +
      `/list - Show all sessions\n` +
      `/switch &lt;name&gt; - Switch to session\n` +
      `/new [name] [path] - Create new session\n\n` +
      `<b>Control:</b>\n` +
      `/plan &lt;msg&gt; - Start plan mode\n` +
      `/queue - Queue tasks for batch execution\n` +
      `/stop - Interrupt current query\n` +
      `/kill - Terminate session\n` +
      `/retry - Retry last message\n` +
      `/status - Show session details\n` +
      `/model - Switch model\n` +
      `/restart - Restart bot\n\n` +
      `<b>Tips:</b>\n` +
      `• Prefix with <code>!</code> to interrupt queue\n` +
      `• Say "think" for extended reasoning\n` +
      `• Send voice/photo/files directly\n` +
      `• Use /new to reset conversation`,
    { parse_mode: "HTML" },
  );
}

/**
 * /new [name] [path] - Start a fresh session.
 */
export async function handleNew(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Parse optional args: /new [name] [path]
  const text = ctx.message?.text || "";
  const parts = text.split(/\s+/).slice(1);
  const explicitName = parts[0] || undefined;
  const explicitPath = parts[1] || WORKING_DIR;

  // Stop any running query
  if (session.isRunning) {
    await session.stop();
    await Bun.sleep(100);
    session.clearStopRequested();
  }

  // Clear in-memory session
  await session.kill();

  // Create telegram session
  const newSession = addTelegramSession(explicitPath, explicitName);

  // Update working directory for this session
  session.setWorkingDir(explicitPath);

  const chatId = ctx.chat?.id;
  const branch = await getGitBranch(explicitPath);

  await ctx.reply(
    `🆕 <code>${newSession.name}</code>\n` + `📁 <code>${explicitPath}</code>`,
    { parse_mode: "HTML" },
  );

  // Pin status for new session
  if (chatId) {
    updatePinnedStatus(ctx.api, chatId, {
      sessionName: newSession.name,
      isPlanMode: false,
      model: session.modelDisplayName,
      branch,
    }).catch(() => {});
  }
}

/**
 * /stop - Interrupt current generation or cancel queue.
 */
export async function handleStop(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Check for active queue
  const queue = getActiveQueue();
  if (queue) {
    queue.cancel();
    await ctx.reply("🛑 Queue cancelled.");
    await Bun.sleep(100);
    session.clearStopRequested();
    return;
  }

  const result = await session.stop();

  if (result === "stopped") {
    await ctx.reply("🛑 Query stopped.");
  } else if (result === "pending") {
    await ctx.reply("⏳ Cancelling...");
  } else {
    await ctx.reply("⏸️ Nothing running.");
  }

  await Bun.sleep(100);
  session.clearStopRequested();
}

/**
 * /kill - Terminate session entirely.
 */
export async function handleKill(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Stop any running query first
  if (session.isRunning) {
    await session.stop();
    await Bun.sleep(100);
    session.clearStopRequested();
  }

  if (!session.isActive) {
    await ctx.reply("⏸️ No active session.");
    return;
  }

  // Get session name before killing (kill() clears it)
  const sessionName = session.sessionName;
  await session.kill();
  if (sessionName) {
    removeSession(sessionName);
  }
  await ctx.reply("💀 Session terminated. Next message starts fresh.");
}

/**
 * /status - Show detailed status.
 */
export async function handleStatus(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const activeSession = getActiveSession();
  const sessionName = session.sessionName || activeSession?.name;

  if (!sessionName) {
    await ctx.reply("No session. Use /list or /new.");
    return;
  }

  const lines: string[] = [`📊 <b>${sessionName}</b>\n`];

  // Model
  lines.push(`🤖 ${session.modelDisplayName}`);

  // Session/query status
  if (session.isRunning) {
    const elapsed = session.queryStarted
      ? Math.floor((Date.now() - session.queryStarted.getTime()) / 1000)
      : 0;
    lines.push(`🔄 Running (${elapsed}s)`);
    if (session.currentTool) {
      lines.push(`   └─ ${session.currentTool}`);
    }
  } else if (session.isActive) {
    lines.push(`✅ Ready (${session.sessionId?.slice(0, 8)}...)`);
    if (session.lastTool) {
      lines.push(`   └─ Last: ${session.lastTool}`);
    }
  } else {
    lines.push("⏳ Not started");
  }

  // Last activity
  if (session.lastActivity) {
    const ago = Math.floor(
      (Date.now() - session.lastActivity.getTime()) / 1000,
    );
    lines.push(`⏱️ ${ago}s ago`);
  }

  // Usage stats (compact)
  if (session.lastUsage) {
    const u = session.lastUsage;
    const inK = Math.round((u.input_tokens || 0) / 1000);
    const outK = Math.round((u.output_tokens || 0) / 1000);
    lines.push(`📈 ${inK}k in / ${outK}k out`);
  }

  // Error status
  if (session.lastError) {
    lines.push(`⚠️ ${session.lastError.slice(0, 50)}`);
  }

  // Working directory
  const dir = (
    session.workingDir ||
    activeSession?.info.dir ||
    WORKING_DIR
  ).replace(/^\/Users\/[^/]+/, "~");
  lines.push(`📁 <code>${dir}</code>`);

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/**
 * /model - Show/switch model with inline buttons.
 */
export async function handleModel(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const currentModel = session.model;
  const models = Object.entries(MODEL_DISPLAY_NAMES) as [ModelId, string][];

  const buttons = models.map(([id, name]) => [
    {
      text: id === currentModel ? `✓ ${name}` : name,
      callback_data: `model:${id}`,
    },
  ]);

  await ctx.reply(`🤖 <b>Model:</b> ${session.modelDisplayName}`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });
}

/**
 * /restart - Restart the bot process.
 */
export async function handleRestart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const msg = await ctx.reply("🔄 Restarting...");

  if (chatId && msg.message_id) {
    try {
      await Bun.write(
        RESTART_FILE,
        JSON.stringify({
          chat_id: chatId,
          message_id: msg.message_id,
          timestamp: Date.now(),
        }),
      );
    } catch (e) {
      console.warn("Failed to save restart info:", e);
    }
  }

  await Bun.sleep(500);
  process.exit(0);
}

/**
 * /retry - Retry the last message.
 */
export async function handleRetry(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (!session.lastMessage) {
    await ctx.reply("❌ No message to retry.");
    return;
  }

  if (session.isRunning) {
    await ctx.reply("⏳ Query running. Use /stop first.");
    return;
  }

  const message = session.lastMessage;
  await ctx.reply(`🔄 Retrying...`);

  const { handleText } = await import("./text");

  const fakeCtx = {
    ...ctx,
    message: { ...ctx.message, text: message },
  } as Context;

  await handleText(fakeCtx);
}

// ============== Session Commands ==============

/**
 * /list - Show all sessions with switch buttons.
 */
export async function handleList(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const sessions = getSessions();
  const active = getActiveSession();

  if (sessions.length === 0) {
    await ctx.reply(
      "📋 No sessions\n\nStart Claude Code to see sessions here.",
    );
    return;
  }

  // Resolve branches for all sessions
  const branches = await Promise.all(sessions.map((s) => getGitBranch(s.dir)));

  const lines: string[] = ["📋 <b>Sessions</b>\n"];

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]!;
    const isActive = active?.name === s.name;
    const marker = isActive ? "✅ " : "• ";
    const dir = s.dir.replace(/^\/Users\/[^/]+/, "~");
    const ago = formatTimeAgo(s.lastActivity);
    const branch = branches[i];

    const meta = [dir, branch ? `🌿 ${branch}` : null, ago]
      .filter(Boolean)
      .join(" · ");
    lines.push(`${marker}<b>${s.name}</b>`, `   ${meta}`, "");
  }

  // Create inline buttons for all sessions (mark active with ✓)
  const buttons = sessions.map((s) => [
    {
      text: active?.name === s.name ? `✓ ${s.name}` : s.name,
      callback_data: `switch:${s.name}`,
    },
  ]);

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined,
  });
}

/**
 * /switch <name> - Switch to a session.
 */
export async function handleSwitch(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const text = ctx.message?.text || "";
  const name = text.split(/\s+/)[1];

  if (!name) {
    await ctx.reply("Usage: /switch &lt;name&gt;", { parse_mode: "HTML" });
    return;
  }

  const success = setActiveSession(name);

  if (success) {
    const active = getActiveSession();
    if (active) {
      session.loadFromRegistry(active.info);
      const dir = active.info.dir.replace(/^\/Users\/[^/]+/, "~");
      await ctx.reply(`✅ <code>${name}</code>\n📁 <code>${dir}</code>`, {
        parse_mode: "HTML",
      });

      // Show conversation history for desktop sessions
      if (active.info.source === "desktop" && active.info.id) {
        getRecentHistory(active.info.id)
          .then((turns) => {
            if (turns.length > 0) {
              ctx.reply(formatHistoryMessage(turns), { parse_mode: "HTML" });
            }
          })
          .catch(() => {});
      }

      // Update pinned status
      const chatId = ctx.chat?.id;
      if (chatId) {
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
    await ctx.reply(`❌ "${name}" not found. Use /list.`);
  }
}

/**
 * /refresh - Force refresh sessions (hidden command for debugging).
 */
export async function handleRefresh(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  await forceRefresh();
  const sessions = getSessions();
  await ctx.reply(`🔄 Refreshed. Found ${sessions.length} session(s).`);
}

/**
 * /plan <message> - Start Claude in plan mode.
 */
export async function handlePlan(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text || "";

  if (!userId || !chatId) {
    return;
  }

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Parse message after /plan
  const message = text.replace(/^\/plan\s*/, "").trim();
  if (!message) {
    await ctx.reply("Usage: /plan &lt;your planning request&gt;", {
      parse_mode: "HTML",
    });
    return;
  }

  // Rate limit
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(`⏳ Rate limited. Wait ${retryAfter!.toFixed(1)}s.`);
    return;
  }

  // Sync with registry if no session loaded
  if (!session.sessionName) {
    const active = await getActiveSession();
    if (active) {
      session.loadFromRegistry(active.info);
    }
  }

  // Mark processing started
  const stopProcessing = session.startProcessing();
  const typing = startTypingIndicator(ctx);

  // Create streaming state
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    await ctx.reply("📋 Starting plan mode...");

    const response = await session.sendMessageStreaming(
      message,
      username,
      userId,
      statusCallback,
      chatId,
      ctx,
      "plan",
    );

    // Check if plan is ready for approval
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

    await auditLog(userId, username, "PLAN", message, response);
  } catch (error) {
    console.error("Error in plan mode:", error);

    // Cleanup tool messages
    for (const toolMsg of state.toolMessages) {
      try {
        await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
      } catch {
        // Ignore cleanup errors
      }
    }

    const errorStr = String(error);
    if (errorStr.includes("abort") || errorStr.includes("cancel")) {
      const wasInterrupt = session.consumeInterruptFlag();
      if (!wasInterrupt) {
        await ctx.reply("🛑 Query stopped.");
      }
    } else {
      await ctx.reply(`❌ Error: ${errorStr.slice(0, 200)}`);
    }
  } finally {
    stopProcessing();
    typing.stop();
  }
}

/**
 * /pin - Update/create pinned status message.
 */
export async function handlePin(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (!chatId) return;

  const active = getActiveSession();
  const branch = await getGitBranch(session.workingDir);
  const status = {
    sessionName: active?.name || session.sessionName || null,
    isPlanMode: session.isPlanMode,
    model: session.modelDisplayName,
    branch,
  };

  await updatePinnedStatus(ctx.api, chatId, status);
  await ctx.reply("📌 Status pinned.");
}

/**
 * /queue - Queue multiple tasks for sequential execution.
 *
 * Usage:
 *   /queue
 *   1. Fix the failing test
 *   2. Add input validation
 *   3. Write tests
 *   4. Create a PR
 *
 * With no tasks: show current queue status.
 */
export async function handleQueue(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text || "";

  if (!userId || !chatId) return;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Check for active queue status request
  const queue = getActiveQueue();

  // Parse tasks from message (everything after /queue)
  const body = text.replace(/^\/queue\s*/, "").trim();

  if (!body) {
    // No tasks provided - show status or usage
    if (queue) {
      await ctx.reply(queue.formatProgress(), { parse_mode: "HTML" });
    } else {
      await ctx.reply(
        `📋 <b>Task Queue</b>\n\n` +
          `Send a list of tasks:\n\n` +
          `<code>/queue\n` +
          `1. Fix the failing test\n` +
          `2. Add input validation\n` +
          `3. Write tests\n` +
          `4. Create a PR</code>`,
        { parse_mode: "HTML" },
      );
    }
    return;
  }

  // Check if a queue is already running
  if (queue) {
    await ctx.reply("⏳ A queue is already running. Use /stop to cancel it.");
    return;
  }

  // Check if session is busy
  if (session.isRunning) {
    await ctx.reply("⏳ Session is busy. Use /stop first.");
    return;
  }

  // Rate limit
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(`⏳ Rate limited. Wait ${retryAfter!.toFixed(1)}s.`);
    return;
  }

  // Parse the task list
  const taskDescriptions = parseTasks(body);

  if (taskDescriptions.length === 0) {
    await ctx.reply("❌ No tasks found. Send a numbered or bulleted list.");
    return;
  }

  if (taskDescriptions.length > 20) {
    await ctx.reply("❌ Too many tasks (max 20).");
    return;
  }

  // Create and start the queue
  const taskQueue = new TaskQueue(taskDescriptions, chatId, userId, username);

  await auditLog(
    userId,
    username,
    "QUEUE_START",
    `${taskDescriptions.length} tasks`,
    taskDescriptions.join(" | "),
  );

  // Process queue (runs in background, doesn't block the command)
  taskQueue.process(ctx).catch(async (error) => {
    console.error("Queue processing error:", error);
    try {
      await ctx.reply(`❌ Queue error: ${String(error).slice(0, 200)}`);
    } catch {
      // Can't send message, ignore
    }
  });
}
