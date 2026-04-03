/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /help, /new, /stop, /kill, /status, /model, /restart, /retry
 * /list, /switch, /refresh, /pin, /watch, /unwatch, /pwd, /cd, /ls
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
  getSession,
  forceRefresh,
  removeSession,
  updatePinnedStatus,
  getGitBranch,
  sendSwitchHistory,
} from "../sessions";
import type { SessionInfo } from "../sessions/types";
import { findSessionJsonlPath } from "../sessions/tailer";
import { auditLog } from "../utils";
import {
  isRelayAvailable,
  getRelayDirs,
  disconnectRelay,
  scanPortFiles,
} from "../relay";
import {
  startWatchingSession,
  startWatchingAndNotify,
  stopWatching,
  isWatching,
} from "./watch";
import {
  createOpId,
  elapsedMs,
  error as logError,
  info,
  warn,
} from "../logger";

function relayIdentity(pf: {
  sessionId?: string;
  ppid?: number;
  pid: number;
}): string {
  if (pf.sessionId) return `session:${pf.sessionId}`;
  if (pf.ppid !== undefined) return `ppid:${pf.ppid}`;
  return `pid:${pf.pid}`;
}

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
      `/new [path] - Spawn desktop session (cmux)\n\n` +
      `<b>Watch:</b>\n` +
      `/watch [name] - Watch desktop session live\n` +
      `/unwatch - Stop watching\n\n` +
      `<b>Control:</b>\n` +
      `/stop - Interrupt current query\n` +
      `/kill [name] - Terminate session (SIGTERM)\n` +
      `/retry - Retry last message\n` +
      `/status - Show session details\n` +
      `/model - Switch model\n` +
      `/restart - Restart bot\n\n` +
      `<b>Files:</b>\n` +
      `/pwd - Show working directory\n` +
      `/cd &lt;path&gt; - Change directory\n` +
      `/ls [path] - List directory\n\n` +
      `<b>Tips:</b>\n` +
      `• Prefix with <code>!</code> to interrupt active query\n` +
      `• Say "think" for extended reasoning\n` +
      `• Send voice/photo/files directly\n` +
      `• Use /new to reset conversation`,
    { parse_mode: "HTML" },
  );
}

/**
 * /new [path] - Spawn a desktop Claude session in cmux.
 */
export async function handleNew(ctx: Context): Promise<void> {
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
        "<code>/new</code> opens a desktop Claude terminal via cmux.\n" +
        'Install from: <a href="https://cmux.dev">cmux.dev</a>',
      { parse_mode: "HTML" },
    );
    return;
  }

  const text = ctx.message?.text || "";
  const rawPath = text.split(/\s+/).slice(1).join(" ").trim();
  const explicitPath = rawPath ? resolve(WORKING_DIR, rawPath) : WORKING_DIR;
  const opId = createOpId("spawn");
  const spawnStartedAt = Date.now();
  info("request: started", {
    opId,
    requestKind: "spawn",
    chatId,
    userId,
    explicitPath,
  });

  try {
    const s = await stat(explicitPath);
    if (!s.isDirectory()) {
      warn("spawn: target is not a directory", {
        opId,
        chatId,
        userId,
        explicitPath,
        durationMs: elapsedMs(spawnStartedAt),
      });
      await ctx.reply("❌ Not a directory.");
      return;
    }
  } catch {
    warn("spawn: path does not exist", {
      opId,
      chatId,
      userId,
      explicitPath,
      durationMs: elapsedMs(spawnStartedAt),
    });
    await ctx.reply("❌ Path does not exist.");
    return;
  }

  const dir = explicitPath.replace(/^\/Users\/[^/]+/, "~");
  await ctx.reply(
    `🚀 Spawning desktop session...\n📁 <code>${escapeHtml(dir)}</code>`,
    {
      parse_mode: "HTML",
    },
  );

  try {
    const beforeRelays = (await scanPortFiles(true)).filter(
      (pf) => pf.cwd === explicitPath,
    );
    const knownRelayIds = new Set(beforeRelays.map(relayIdentity));
    const beforeSessions = getSessions().filter((s) => s.dir === explicitPath);
    const knownSessionIds = new Set(
      beforeSessions.map((s) => s.id).filter(Boolean),
    );
    const knownSessionPids = new Set(
      beforeSessions
        .map((s) => s.pid)
        .filter((pid): pid is number => pid !== undefined),
    );

    const wsResult = Bun.spawnSync([
      "cmux",
      "new-workspace",
      "--cwd",
      explicitPath,
    ]);
    const wsOutput = wsResult.stdout.toString().trim();
    const wsMatch = wsOutput.match(/workspace:(\d+)/);
    if (!wsMatch) {
      warn("spawn: failed to create workspace", {
        opId,
        chatId,
        userId,
        explicitPath,
        durationMs: elapsedMs(spawnStartedAt),
      });
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
    let spawnedRelay: (typeof beforeRelays)[number] | null = null;
    while (Date.now() < deadline) {
      await Bun.sleep(2000);
      const portFiles = await scanPortFiles(true);
      const newRelays = portFiles.filter(
        (pf) =>
          pf.cwd === explicitPath && !knownRelayIds.has(relayIdentity(pf)),
      );
      if (newRelays.length > 1) {
        warn("spawn: ambiguous new relays", {
          opId,
          chatId,
          userId,
          explicitPath,
          durationMs: elapsedMs(spawnStartedAt),
          candidateCount: newRelays.length,
        });
        await ctx.reply(
          "⚠️ Session spawned, but multiple new relays appeared.\n" +
            "Use /list to pick the right session.",
        );
        return;
      }
      if (newRelays.length === 1) {
        spawnedRelay = newRelays[0]!;
        break;
      }
    }

    if (!spawnedRelay) {
      warn("spawn: relay not detected", {
        opId,
        chatId,
        userId,
        explicitPath,
        durationMs: elapsedMs(spawnStartedAt),
      });
      await ctx.reply(
        "⚠️ Session spawned but relay not detected yet. Check cmux and try /list.",
      );
      return;
    }

    await forceRefresh();
    const sessions = getSessions();
    const dirSessions = sessions.filter((s) => s.dir === explicitPath);
    let spawned =
      (spawnedRelay.sessionId
        ? dirSessions.find((s) => s.id === spawnedRelay?.sessionId)
        : undefined) ||
      (spawnedRelay.ppid !== undefined
        ? dirSessions.find((s) => s.pid === spawnedRelay?.ppid)
        : undefined);

    if (!spawned) {
      const newCandidates = dirSessions.filter(
        (s) =>
          (Boolean(s.id) && !knownSessionIds.has(s.id)) ||
          (s.pid !== undefined && !knownSessionPids.has(s.pid)),
      );
      if (newCandidates.length === 1) {
        spawned = newCandidates[0]!;
      }
    }

    if (!spawned && beforeSessions.length === 0 && dirSessions.length === 1) {
      spawned = dirSessions[0]!;
    }

    if (spawned) {
      setActiveSession(spawned.name);

      // Wait for JSONL to appear (needed for watch/tailer)
      if (spawned.id) {
        const jsonlDeadline = Date.now() + 10_000;
        while (Date.now() < jsonlDeadline) {
          if (await findSessionJsonlPath(spawned.id)) break;
          await Bun.sleep(1000);
        }
      }

      const watching = await startWatchingSession(
        ctx.api,
        chatId,
        spawned.name,
        "spawn",
      );
      if (watching) {
        await ctx.reply(
          `✅ <b>${escapeHtml(spawned.name)}</b> ready\n` +
            `📁 <code>${escapeHtml(dir)}</code>\n\n` +
            `Watching live. Type a message to send via relay.`,
          { parse_mode: "HTML" },
        );
      } else {
        await ctx.reply(`✅ <b>${escapeHtml(spawned.name)}</b> ready`, {
          parse_mode: "HTML",
        });
      }
      info("request: completed", {
        opId,
        requestKind: "spawn",
        chatId,
        userId,
        explicitPath,
        sessionName: spawned.name,
        sessionId: spawned.id,
        durationMs: elapsedMs(spawnStartedAt),
        watching,
      });
    } else {
      warn("spawn: session unresolved after relay detection", {
        opId,
        chatId,
        userId,
        explicitPath,
        durationMs: elapsedMs(spawnStartedAt),
      });
      await ctx.reply(
        "⚠️ Session spawned, but could not uniquely identify the new session.\n" +
          "Use /list to find it.",
      );
    }
  } catch (err) {
    logError("spawn: failed", err, {
      opId,
      chatId,
      userId,
      explicitPath,
      durationMs: elapsedMs(spawnStartedAt),
    });
    await ctx.reply(`❌ Spawn failed: ${String(err).slice(0, 200)}`);
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
 * Kill a session by SIGTERM, clean up relay/watch/cache.
 * Shared by /kill command and kill: callback.
 */
export async function killSession(
  sessionInfo: SessionInfo,
  chatId: number,
  botApi: Context["api"],
): Promise<{ killed: boolean; pid?: number }> {
  stopWatching(chatId, botApi, "kill");
  disconnectRelay(sessionInfo.dir);

  let pid: number | undefined;
  if (sessionInfo.pid) {
    pid = sessionInfo.pid;
    try {
      process.kill(sessionInfo.pid, "SIGTERM");
    } catch {
      // Process already dead — that's fine
    }
  }

  const active = getActiveSession();
  if (active?.name === sessionInfo.name) {
    if (session.isRunning) {
      await session.stop();
      await Bun.sleep(100);
      session.clearStopRequested();
    }
    await session.kill();
  }

  removeSession(sessionInfo.name);

  info("kill: terminated", {
    sessionName: sessionInfo.name,
    sessionDir: sessionInfo.dir,
    pid,
  });

  return { killed: true, pid };
}

/**
 * Show session list after a kill (for picking next session or killing another).
 */
export async function sendPostKillSessionList(
  ctx: Context,
  chatId: number,
  action: "switch" | "kill",
): Promise<void> {
  // Skip forceRefresh — killed process may still be exiting and would get rediscovered
  const sessions = getSessions();

  if (sessions.length === 0) {
    await ctx.reply("No sessions available. Use /new to start one.");
    return;
  }

  const branches = await Promise.all(sessions.map((s) => getGitBranch(s.dir)));
  const lines: string[] = [
    action === "switch"
      ? "📋 <b>Select a session to continue:</b>\n"
      : "📋 <b>Select a session to kill:</b>\n",
  ];

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]!;
    const dir = s.dir.replace(/^\/Users\/[^/]+/, "~");
    const ago = formatTimeAgo(s.lastActivity);
    const branch = branches[i];
    const meta = [dir, branch ? `🌿 ${branch}` : null, ago]
      .filter(Boolean)
      .join(" · ");
    lines.push(`• <b>${escapeHtml(s.name)}</b>`, `   ${meta}`, "");
  }

  const buttons = sessions.map((s) => [
    {
      text: action === "kill" ? `Kill ${s.name}` : s.name,
      callback_data: `${action}:${s.name}`,
    },
  ]);

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });
}

/**
 * /kill [name] - Terminate a Claude session.
 */
export async function handleKill(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (!chatId) return;

  const text = ctx.message?.text || "";
  const targetName = text.split(/\s+/).slice(1).join(" ").trim();

  // Resolve target: explicit name > active session
  const resolvedName = targetName || getActiveSession()?.name;

  if (resolvedName) {
    const target = getSession(resolvedName);
    if (!target) {
      await ctx.reply(`❌ Session "${escapeHtml(resolvedName)}" not found.`, {
        parse_mode: "HTML",
      });
      return;
    }
    const { pid } = await killSession(target, chatId, ctx.api);
    const pidStr = pid ? ` (pid ${pid})` : "";
    await ctx.reply(`💀 Killed <b>${escapeHtml(resolvedName)}</b>${pidStr}`, {
      parse_mode: "HTML",
    });
    await sendPostKillSessionList(ctx, chatId, "switch");
    return;
  }

  // No name and no active session — show kill picker
  const sessions = getSessions();
  if (sessions.length === 0) {
    await ctx.reply("No sessions to kill.");
    return;
  }
  await sendPostKillSessionList(ctx, chatId, "kill");
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

  // Git branch
  const branchDir = session.workingDir || activeSession?.info.dir;
  const branch = branchDir ? await getGitBranch(branchDir) : null;
  if (branch) {
    lines.push(`🌿 <code>${branch}</code>`);
  }

  // Relay status
  const relayUp = await isRelayAvailable({
    sessionId: activeSession?.info.id || session.sessionId || undefined,
    sessionDir: session.workingDir || activeSession?.info.dir,
    claudePid: activeSession?.info.pid,
  });
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
      warn("restart: failed to save state", e, { path: RESTART_FILE });
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

  // Auto-watch active desktop session if not already watching
  const chatId = ctx.chat?.id;
  if (chatId && active?.info.source === "desktop" && !isWatching(chatId)) {
    await startWatchingAndNotify(ctx, chatId, active.name, "list_auto");
  }
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
        if (
          !(await startWatchingAndNotify(ctx, chatId, active.name, "switch"))
        ) {
          await ctx.reply(`✅ <code>${name}</code>\n📁 <code>${dir}</code>`, {
            parse_mode: "HTML",
          });
        }
      } else {
        await ctx.reply(`✅ <code>${name}</code>\n📁 <code>${dir}</code>`, {
          parse_mode: "HTML",
        });
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

    const lines: string[] = [`📁 <code>${escapeHtml(targetPath)}</code>\n`];

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
