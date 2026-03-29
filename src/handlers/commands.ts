/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /help, /new, /stop, /status, /restart, /retry
 * /list, /switch
 */

import { readdir, stat } from "fs/promises";
import { resolve } from "path";
import type { Context } from "grammy";
import { session, MODEL_DISPLAY_NAMES, type ModelId } from "../session";
import { WORKING_DIR, ALLOWED_USERS, RESTART_FILE } from "../config";
import { formatTimeAgo, escapeHtml } from "../formatting";
import { isAuthorized, rateLimiter, isPathAllowed } from "../security";
import {
  getSessions,
  getActiveSession,
  setActiveSession,
  addTelegramSession,
  forceRefresh,
  removeSession,
  updatePinnedStatus,
  getGitBranch,
  sendSwitchHistory,
} from "../sessions";
import { auditLog, auditLogRateLimit, startTypingIndicator } from "../utils";
import {
  StreamingState,
  createStatusCallback,
  createPlanApprovalKeyboard,
  sendPlanContent,
} from "./streaming";
import { TaskQueue, parseTasks, getActiveQueue } from "../queue";
import { isRelayAvailable, getRelayDirs, disconnectRelay, scanPortFiles } from "../relay";
import { startWatchingSession, stopWatching } from "./watch";

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
      `/new [name] [path] - Create new session\n` +
      `/spawn [path] - Spawn desktop session (cmux)\n\n` +
      `<b>Watch:</b>\n` +
      `/watch [name] - Watch desktop session live\n` +
      `/unwatch - Stop watching\n\n` +
      `<b>Control:</b>\n` +
      `/plan &lt;msg&gt; - Start plan mode\n` +
      `/queue - Queue tasks for batch execution\n` +
      `/skip - Skip current queue task\n` +
      `/stop - Interrupt current query\n` +
      `/kill - Terminate session\n` +
      `/retry - Retry last message\n` +
      `/status - Show session details\n` +
      `/model - Switch model\n` +
      `/restart - Restart bot\n\n` +
      `<b>Files:</b>\n` +
      `/pwd - Show working directory\n` +
      `/cd &lt;path&gt; - Change directory\n` +
      `/ls [path] - List directory\n\n` +
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

  const chatId = ctx.chat?.id;
  const activeSession = getActiveSession();
  const sessionDir = session.workingDir || activeSession?.info.dir;
  const hasRelay = sessionDir ? await isRelayAvailable(sessionDir) : false;

  if (!session.isActive && !hasRelay) {
    await ctx.reply("⏸️ No active session.");
    return;
  }

  // Disconnect relay if active
  if (sessionDir && hasRelay) {
    disconnectRelay(sessionDir);
  }

  // Stop watching if active
  if (chatId) {
    stopWatching(chatId, ctx.api);
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

  // Relay status
  const relayUp = await isRelayAvailable(
    session.workingDir || activeSession?.info.dir,
  );
  lines.push(relayUp ? "📡 Relay: connected" : "📡 Relay: unavailable");

  // Resume command (tap to copy)
  if (session.sessionId) {
    lines.push(`\n🔗 <code>claude --resume ${session.sessionId}</code>`);
  }

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

  // Resolve branches and relay status for all sessions
  const [branches, relayDirs] = await Promise.all([
    Promise.all(sessions.map((s) => getGitBranch(s.dir))),
    getRelayDirs(),
  ]);
  const relayDirSet = new Set(relayDirs);

  const lines: string[] = ["📋 <b>Sessions</b>\n"];

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]!;
    const isActive = active?.name === s.name;
    const marker = isActive ? "✅ " : "• ";
    const dir = s.dir.replace(/^\/Users\/[^/]+/, "~");
    const ago = formatTimeAgo(s.lastActivity);
    const branch = branches[i];
    const hasRelay = relayDirSet.has(s.dir);

    const meta = [
      dir,
      branch ? `🌿 ${branch}` : null,
      hasRelay ? "📡" : null,
      ago,
    ]
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
      const chatId = ctx.chat?.id;
      const dir = active.info.dir.replace(/^\/Users\/[^/]+/, "~");

      await sendSwitchHistory(ctx, active.info);

      // Auto-watch desktop sessions
      if (active.info.source === "desktop" && chatId) {
        const watching = await startWatchingSession(
          ctx.api,
          chatId,
          active.name,
        );
        if (watching) {
          await ctx.reply(
            `👁 Watching <b>${escapeHtml(active.name)}</b>\n` +
              `📁 <code>${escapeHtml(dir)}</code>\n\n` +
              `Live events will stream here.\n` +
              `Type a message to send via relay.\n` +
              `Use /unwatch to stop.`,
            { parse_mode: "HTML" },
          );
        } else {
          await ctx.reply(
            `✅ <code>${name}</code>\n📁 <code>${dir}</code>`,
            { parse_mode: "HTML" },
          );
        }
      } else {
        await ctx.reply(
          `✅ <code>${name}</code>\n📁 <code>${dir}</code>`,
          { parse_mode: "HTML" },
        );
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
 * /skip - Skip the current queue task, continue with the rest.
 */
export async function handleSkip(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const queue = getActiveQueue();
  if (!queue) {
    await ctx.reply("⏸️ No queue running.");
    return;
  }

  queue.skipCurrent();
  const current = queue.tasks[queue.currentTaskIndex];
  const desc = current ? current.description.slice(0, 60) : "current task";
  await ctx.reply(`⏭️ Skipping: ${desc}`);
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

  // Append to running queue
  if (queue) {
    const newTasks = parseTasks(body);
    if (newTasks.length === 0) {
      await ctx.reply("❌ No tasks found. Send a numbered or bulleted list.");
      return;
    }
    for (const desc of newTasks) {
      queue.addTask(desc);
    }
    await ctx.reply(
      `📋 Added ${newTasks.length} task(s) to queue (now ${queue.tasks.length} total).`,
    );
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

// ============== Filesystem Navigation Commands ==============

/**
 * /pwd - Show current working directory.
 */
export async function handlePwd(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const [allowed, retryAfter] = rateLimiter.check(userId!);
  if (!allowed) {
    await ctx.reply(`⏳ Rate limited. Wait ${retryAfter!.toFixed(1)}s.`);
    return;
  }

  const dir = session.workingDir || WORKING_DIR;
  await ctx.reply(`📁 <code>${escapeHtml(dir)}</code>`, {
    parse_mode: "HTML",
  });
}

/**
 * /cd <path> - Change working directory.
 *
 * Validates the path exists, is a directory, and is within allowed paths.
 */
export async function handleCd(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const [allowed, retryAfter] = rateLimiter.check(userId!);
  if (!allowed) {
    await ctx.reply(`⏳ Rate limited. Wait ${retryAfter!.toFixed(1)}s.`);
    return;
  }

  const rawPath = ((ctx.match as string | undefined) ?? "").trim();

  if (!rawPath) {
    await ctx.reply("Usage: /cd &lt;path&gt;", { parse_mode: "HTML" });
    return;
  }

  // resolve() normalizes ../segments and handles both absolute and relative paths
  const targetPath = resolve(session.workingDir || WORKING_DIR, rawPath);

  // Validate path is allowed
  if (!isPathAllowed(targetPath)) {
    await ctx.reply("❌ Path not in allowed directories.");
    return;
  }

  // Validate path exists and is a directory
  try {
    const stats = await stat(targetPath);
    if (!stats.isDirectory()) {
      await ctx.reply("❌ Not a directory.");
      return;
    }
  } catch {
    await ctx.reply("❌ Path does not exist.");
    return;
  }

  session.setWorkingDir(targetPath);
  await ctx.reply(`📂 Now in: <code>${escapeHtml(targetPath)}</code>`, {
    parse_mode: "HTML",
  });
}

/**
 * /ls [path] - List directory contents.
 *
 * Defaults to current working directory. Shows folders and files with indicators.
 */
export async function handleLs(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const [allowed, retryAfter] = rateLimiter.check(userId!);
  if (!allowed) {
    await ctx.reply(`⏳ Rate limited. Wait ${retryAfter!.toFixed(1)}s.`);
    return;
  }

  const rawPath = ((ctx.match as string | undefined) ?? "").trim();

  // resolve() normalizes ../segments and handles both absolute and relative paths
  const targetPath = rawPath
    ? resolve(session.workingDir || WORKING_DIR, rawPath)
    : session.workingDir || WORKING_DIR;

  // Validate path is allowed
  if (!isPathAllowed(targetPath)) {
    await ctx.reply("❌ Path not in allowed directories.");
    return;
  }

  try {
    const entries = await readdir(targetPath, { withFileTypes: true });

    if (entries.length === 0) {
      await ctx.reply(
        `📁 <code>${escapeHtml(targetPath)}</code>\n\n<i>(empty)</i>`,
        { parse_mode: "HTML" },
      );
      return;
    }

    // Sort: directories first, then symlinks, then files, all alphabetical
    const sorted = entries.sort((a, b) => {
      const aIsDir = a.isDirectory();
      const bIsDir = b.isDirectory();
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.name.localeCompare(b.name);
    });

    const lines: string[] = [
      `📁 <code>${escapeHtml(targetPath)}</code>\n`,
    ];

    for (const entry of sorted.slice(0, 50)) {
      let icon: string;
      let suffix = "";
      if (entry.isDirectory()) {
        icon = "📂";
        suffix = "/";
      } else if (entry.isSymbolicLink()) {
        icon = "🔗";
      } else {
        icon = "📄";
      }
      lines.push(`${icon} <code>${escapeHtml(entry.name)}${suffix}</code>`);
    }

    if (entries.length > 50) {
      lines.push(`\n<i>... and ${entries.length - 50} more</i>`);
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  } catch {
    await ctx.reply("❌ Cannot read directory.");
  }
}

/**
 * /spawn [path] - Spawn a desktop Claude session in cmux.
 */
export async function handleSpawn(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (!chatId) return;

  if (!Bun.which("cmux")) {
    await ctx.reply(
      "❌ <b>cmux required</b>\n\n" +
        "<code>/spawn</code> opens a desktop Claude terminal via cmux.\n" +
        "Install from: <a href=\"https://cmux.dev\">cmux.dev</a>\n\n" +
        "Use <code>/new</code> for SDK-based sessions instead.",
      { parse_mode: "HTML" },
    );
    return;
  }

  const text = ctx.message?.text || "";
  const rawPath = text.split(/\s+/).slice(1).join(" ").trim();
  const explicitPath = rawPath ? resolve(WORKING_DIR, rawPath) : WORKING_DIR;

  try {
    const s = await stat(explicitPath);
    if (!s.isDirectory()) {
      await ctx.reply("❌ Not a directory.");
      return;
    }
  } catch {
    await ctx.reply("❌ Path does not exist.");
    return;
  }

  const dir = explicitPath.replace(/^\/Users\/[^/]+/, "~");
  await ctx.reply(`🚀 Spawning desktop session...\n📁 <code>${escapeHtml(dir)}</code>`, {
    parse_mode: "HTML",
  });

  try {
    const wsResult = Bun.spawnSync(["cmux", "new-workspace", "--cwd", explicitPath]);
    const wsOutput = wsResult.stdout.toString().trim();
    const wsMatch = wsOutput.match(/workspace:(\d+)/);
    if (!wsMatch) {
      await ctx.reply("❌ Failed to create cmux workspace.");
      return;
    }
    const workspaceId = `workspace:${wsMatch[1]}`;

    await Bun.sleep(1000);
    Bun.spawnSync(["cmux", "send", "--workspace", workspaceId, "cc\n"]);

    // Accept dev channels prompt
    await Bun.sleep(5000);
    Bun.spawnSync(["cmux", "send-key", "--workspace", workspaceId, "Enter"]);

    await ctx.reply("⏳ Waiting for Claude to start...");

    const deadline = Date.now() + 20_000;
    let found = false;
    while (Date.now() < deadline) {
      await Bun.sleep(2000);
      const portFiles = await scanPortFiles(true);
      if (portFiles.some((pf) => pf.cwd === explicitPath)) {
        found = true;
        break;
      }
    }

    if (!found) {
      await ctx.reply("⚠️ Session spawned but relay not detected yet. Check cmux and try /list.");
      return;
    }

    await forceRefresh();
    const sessions = getSessions();
    const spawned = sessions.find((s) => s.dir === explicitPath);

    if (spawned) {
      setActiveSession(spawned.name);
      const watching = await startWatchingSession(ctx.api, chatId, spawned.name);
      if (watching) {
        await ctx.reply(
          `✅ <b>${escapeHtml(spawned.name)}</b> ready\n` +
            `📁 <code>${escapeHtml(dir)}</code>\n\n` +
            `Watching live. Type a message to send via relay.`,
          { parse_mode: "HTML" },
        );
      } else {
        await ctx.reply(`✅ <b>${escapeHtml(spawned.name)}</b> ready`, { parse_mode: "HTML" });
      }
    } else {
      await ctx.reply("✅ Session spawned. Use /list to find it.");
    }
  } catch (err) {
    await ctx.reply(`❌ Spawn failed: ${String(err).slice(0, 200)}`);
  }
}
