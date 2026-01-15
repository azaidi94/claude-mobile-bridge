/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /new, /stop, /status, /resume, /restart
 * /list, /switch, /discover, /kill, /killall
 */

import type { Context } from "grammy";
import { session } from "../session";
import { WORKING_DIR, ALLOWED_USERS, RESTART_FILE } from "../config";
import { isAuthorized } from "../security";
import {
  listSessions,
  setActiveSession,
  getActiveSession,
  unregisterSession,
  loadRegistry,
  saveRegistry,
  cleanupDeadSessions,
  cleanupStaleSessions,
  discoverAndRegister,
  generateName,
  registerSession,
  type SessionInfo,
} from "../sessions";

/**
 * /start - Show welcome message and status.
 */
export async function handleStart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  const status = session.isActive ? "Active session" : "No active session";
  const workDir = WORKING_DIR;

  const activeSession = await getActiveSession();
  const sessionName = activeSession?.name || "none";

  await ctx.reply(
    `🤖 <b>Claude Mobile Bridge</b>\n\n` +
      `Active: <code>${sessionName}</code>\n\n` +
      `<b>Session Commands:</b>\n` +
      `/list - Show all sessions\n` +
      `/switch &lt;name&gt; - Switch session\n` +
      `/discover - Find desktop sessions\n` +
      `/new [name] [path] - New session\n` +
      `/kill - Kill active session\n` +
      `/killall - Kill all sessions\n\n` +
      `<b>Control:</b>\n` +
      `/stop - Stop current query\n` +
      `/status - Detailed status\n` +
      `/retry - Retry last message\n` +
      `/restart - Restart bot\n\n` +
      `<b>Tips:</b>\n` +
      `• <code>!</code> prefix interrupts query\n` +
      `• "think" for extended reasoning`,
    { parse_mode: "HTML" }
  );
}

/**
 * /new [name] [path] - Start a fresh session.
 * With args: creates named session at path
 * Without args: clears current session, next message starts fresh
 */
export async function handleNew(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Parse optional args: /new [name] [path]
  const text = ctx.message?.text || "";
  const parts = text.split(/\s+/).slice(1); // Remove /new
  const explicitName = parts[0] || undefined;
  const explicitPath = parts[1] || WORKING_DIR;

  // Stop any running query
  if (session.isRunning) {
    const result = await session.stop();
    if (result) {
      await Bun.sleep(100);
      session.clearStopRequested();
    }
  }

  // Clear in-memory session
  await session.kill();

  // Generate name and create placeholder session
  const name = await generateName(explicitPath, explicitName);
  const newSession: SessionInfo = {
    id: "", // Will be set when first message is sent
    name,
    dir: explicitPath,
    lastActivity: Date.now(),
    source: "telegram",
  };

  await registerSession(newSession);
  await setActiveSession(name);

  // Update working directory for this session
  session.setWorkingDir(explicitPath);

  await ctx.reply(
    `🆕 Session <code>${name}</code> created\n` +
      `📁 <code>${explicitPath}</code>\n\n` +
      `Next message starts the session.`,
    { parse_mode: "HTML" }
  );
}

/**
 * /stop - Stop the current query (silently).
 */
export async function handleStop(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (session.isRunning) {
    const result = await session.stop();
    if (result) {
      // Wait for the abort to be processed, then clear stopRequested so next message can proceed
      await Bun.sleep(100);
      session.clearStopRequested();
    }
    // Silent stop - no message shown
  }
  // If nothing running, also stay silent
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

  const lines: string[] = ["📊 <b>Bot Status</b>\n"];

  // Session status
  if (session.isActive) {
    lines.push(`✅ Session: Active (${session.sessionId?.slice(0, 8)}...)`);
  } else {
    lines.push("⚪ Session: None");
  }

  // Query status
  if (session.isRunning) {
    const elapsed = session.queryStarted
      ? Math.floor((Date.now() - session.queryStarted.getTime()) / 1000)
      : 0;
    lines.push(`🔄 Query: Running (${elapsed}s)`);
    if (session.currentTool) {
      lines.push(`   └─ ${session.currentTool}`);
    }
  } else {
    lines.push("⚪ Query: Idle");
    if (session.lastTool) {
      lines.push(`   └─ Last: ${session.lastTool}`);
    }
  }

  // Last activity
  if (session.lastActivity) {
    const ago = Math.floor(
      (Date.now() - session.lastActivity.getTime()) / 1000
    );
    lines.push(`\n⏱️ Last activity: ${ago}s ago`);
  }

  // Usage stats
  if (session.lastUsage) {
    const usage = session.lastUsage;
    lines.push(
      `\n📈 Last query usage:`,
      `   Input: ${usage.input_tokens?.toLocaleString() || "?"} tokens`,
      `   Output: ${usage.output_tokens?.toLocaleString() || "?"} tokens`
    );
    if (usage.cache_read_input_tokens) {
      lines.push(
        `   Cache read: ${usage.cache_read_input_tokens.toLocaleString()}`
      );
    }
  }

  // Error status
  if (session.lastError) {
    const ago = session.lastErrorTime
      ? Math.floor((Date.now() - session.lastErrorTime.getTime()) / 1000)
      : "?";
    lines.push(`\n⚠️ Last error (${ago}s ago):`, `   ${session.lastError}`);
  }

  // Working directory
  lines.push(`\n📁 Working dir: <code>${WORKING_DIR}</code>`);

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/**
 * /resume - Resume the last session.
 */
export async function handleResume(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (session.isActive) {
    await ctx.reply("Session already active. Use /new to start fresh first.");
    return;
  }

  const [success, message] = session.resumeLast();
  if (success) {
    await ctx.reply(`✅ ${message}`);
  } else {
    await ctx.reply(`❌ ${message}`);
  }
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

  const msg = await ctx.reply("🔄 Restarting bot...");

  // Save message info so we can update it after restart
  if (chatId && msg.message_id) {
    try {
      await Bun.write(
        RESTART_FILE,
        JSON.stringify({
          chat_id: chatId,
          message_id: msg.message_id,
          timestamp: Date.now(),
        })
      );
    } catch (e) {
      console.warn("Failed to save restart info:", e);
    }
  }

  // Give time for the message to send
  await Bun.sleep(500);

  // Exit - launchd will restart us
  process.exit(0);
}

/**
 * /retry - Retry the last message (resume session and re-send).
 */
export async function handleRetry(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Check if there's a message to retry
  if (!session.lastMessage) {
    await ctx.reply("❌ No message to retry.");
    return;
  }

  // Check if something is already running
  if (session.isRunning) {
    await ctx.reply("⏳ A query is already running. Use /stop first.");
    return;
  }

  const message = session.lastMessage;
  await ctx.reply(`🔄 Retrying: "${message.slice(0, 50)}${message.length > 50 ? "..." : ""}"`);

  // Simulate sending the message again by emitting a fake text message event
  // We do this by directly calling the text handler logic
  const { handleText } = await import("./text");

  // Create a modified context with the last message
  const fakeCtx = {
    ...ctx,
    message: {
      ...ctx.message,
      text: message,
    },
  } as Context;

  await handleText(fakeCtx);
}

// ============== Multi-Session Commands ==============

/**
 * /list - Show all sessions.
 */
export async function handleList(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Cleanup dead/stale sessions first
  await cleanupDeadSessions();

  const sessions = await listSessions();

  if (sessions.length === 0) {
    await ctx.reply(
      "📋 No sessions\n\nUse /new or /discover to create one.",
      { parse_mode: "HTML" }
    );
    return;
  }

  const lines: string[] = ["📋 <b>Sessions</b>\n"];

  for (const s of sessions) {
    const marker = s.isActive ? "▸ " : "  ";
    const status = s.alive ? "" : " ⚠️";
    const dir = s.info.dir.replace(/^\/Users\/[^/]+/, "~");
    const ago = formatTimeAgo(s.info.lastActivity);

    lines.push(
      `${marker}<code>${s.name}</code>${status}`,
      `   ${dir}`,
      `   ${ago}`
    );
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
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
    await ctx.reply("Usage: /switch &lt;session-name&gt;", { parse_mode: "HTML" });
    return;
  }

  const success = await setActiveSession(name);

  if (success) {
    const active = await getActiveSession();
    if (active) {
      // Load session into memory
      session.loadFromRegistry(active.info);
      await ctx.reply(
        `✅ Switched to <code>${name}</code>\n` +
          `📁 <code>${active.info.dir}</code>`,
        { parse_mode: "HTML" }
      );
    }
  } else {
    await ctx.reply(`❌ Session "${name}" not found. Use /list to see available.`);
  }
}

/**
 * /discover - Scan for desktop Claude Code sessions.
 */
export async function handleDiscover(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const msg = await ctx.reply("🔍 Scanning for sessions...");

  const { registered, skipped } = await discoverAndRegister();

  if (registered.length === 0) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      msg.message_id,
      "🔍 No new sessions found"
    );
    return;
  }

  const names = registered.map((n) => `• <code>${n}</code>`).join("\n");
  await ctx.api.editMessageText(
    ctx.chat!.id,
    msg.message_id,
    `🔍 Found ${registered.length} session(s):\n${names}\n\nUse /switch to activate.`,
    { parse_mode: "HTML" }
  );
}

/**
 * /kill - Kill (unregister) the active session.
 */
export async function handleKill(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const active = await getActiveSession();

  if (!active) {
    await ctx.reply("No active session to kill.");
    return;
  }

  // Stop any running query
  if (session.isRunning) {
    await session.stop();
    await Bun.sleep(100);
  }

  // Clear in-memory session
  await session.kill();

  // Unregister from registry
  await unregisterSession(active.name);

  await ctx.reply(`☠️ Session <code>${active.name}</code> killed`, { parse_mode: "HTML" });
}

/**
 * /killall - Kill all sessions.
 */
export async function handleKillAll(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Stop any running query
  if (session.isRunning) {
    await session.stop();
    await Bun.sleep(100);
  }

  // Clear in-memory session
  await session.kill();

  // Clear all from registry
  const registry = await loadRegistry();
  const count = Object.keys(registry.sessions).length;
  registry.sessions = {};
  registry.active = null;
  await saveRegistry(registry);

  await ctx.reply(`☠️ Killed ${count} session(s)`);
}

// Helper function
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
