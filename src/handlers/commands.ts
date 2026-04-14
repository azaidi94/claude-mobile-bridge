/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /help, /new, /stop, /kill, /status, /model, /restart, /retry
 * /list, /switch, /refresh, /pin, /watch, /unwatch, /pwd, /cd, /ls
 */

import { readdir, stat, access } from "fs/promises";
import { realpathSync, statSync } from "fs";
import { resolve } from "path";
import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { session, MODEL_DISPLAY_NAMES, type ModelId } from "../session";
import { triggerRestart } from "../lifecycle";
import {
  ALLOWED_USERS,
  findClaudeCli,
  isDesktopClaudeSpawnSupported,
  DESKTOP_CLAUDE_DEFAULT_ARGS,
  DESKTOP_CLAUDE_COMMAND_TEMPLATE,
  type TerminalApp,
} from "../config";
import {
  getWorkingDir,
  getTerminal,
  getAutoWatchOnSpawn,
  getTopicsEnabled,
} from "../settings";
import { formatTimeAgo, escapeHtml } from "../formatting";
import { isGeneralTopic, isSessionTopic } from "../topics";
import type { TopicManager } from "../topics";
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
  suppressDirNotifications,
} from "../sessions";
import type { SessionInfo } from "../sessions/types";
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
import type { OfflineSession } from "../sessions/offline";
import { listOfflineSessions } from "../sessions/offline";

/** Max sessions to render in /sessions to stay under Telegram's keyboard/message caps. */
const MAX_OFFLINE_SESSIONS = 25;

/** In-memory cache of offline session lists, keyed by chatId.
 *  Each entry carries a generation counter — callbacks from a stale /sessions
 *  message embed the gen they were minted with, and we reject mismatches so
 *  taps on an old message can't resolve against a newer cache.
 *  Populated by handleSessions; consumed by sess_pick / sess_resume callbacks.
 */
export const offlineSessionCache = new Map<
  number,
  { gen: number; sessions: OfflineSession[] }
>();

let offlineSessionGen = 0;

// Topic manager reference — set by index.ts when topics are enabled
let _topicManager: TopicManager | null = null;

export function setTopicManager(tm: TopicManager): void {
  _topicManager = tm;
}

/**
 * Show a session picker keyboard when in General topic with multiple sessions.
 * Returns true if a picker was shown (caller should return early).
 */
async function showSessionPicker(
  ctx: Context,
  action: string,
): Promise<boolean> {
  if (!getTopicsEnabled() || !isGeneralTopic(ctx)) return false;

  const sessions = getSessions();
  if (sessions.length === 0) {
    await ctx.reply("No active sessions.");
    return true;
  }
  if (sessions.length === 1) {
    return false; // Only one session — proceed with it
  }

  const keyboard = new InlineKeyboard();
  for (const s of sessions) {
    keyboard.text(s.name, `${action}:${s.name}`).row();
  }
  await ctx.reply("Pick a session:", { reply_markup: keyboard });
  return true;
}

function bashSingleQuotedPath(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function escapeAppleScriptDoubleQuoted(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function resolveClaudePathForSpawn(): Promise<string | null> {
  const p = findClaudeCli();
  try {
    await access(p);
    return p;
  } catch {
    return null;
  }
}

/**
 * Shared preflight for /new, /sessions → Resume, and `spawnDesktopClaudeSession`.
 * Replies with a user-facing error if desktop spawn can't run on this machine
 * or Claude CLI isn't installed; returns the resolved claude path on success.
 */
async function assertDesktopSpawnReady(
  reply: (text: string) => Promise<unknown>,
): Promise<string | null> {
  if (!isDesktopClaudeSpawnSupported()) {
    await reply(
      "❌ <b>macOS required</b>\n\nDesktop Claude spawn opens Terminal / iTerm on the bot host.",
    );
    return null;
  }
  const claudePath = await resolveClaudePathForSpawn();
  if (!claudePath) {
    await reply(
      "❌ Claude CLI not found. Install Claude Code or set <code>CLAUDE_CLI_PATH</code>.",
    );
    return null;
  }
  return claudePath;
}

/** Fallback path for the cmux CLI when it isn't on PATH (installed via cmux.app). */
const CMUX_APP_BIN = "/Applications/cmux.app/Contents/MacOS/cmux";

function resolveCmuxBin(): string | null {
  const onPath = Bun.which("cmux");
  if (onPath) return onPath;
  try {
    statSync(CMUX_APP_BIN);
    return CMUX_APP_BIN;
  } catch {
    return null;
  }
}

function buildDesktopShellCommand(
  explicitPath: string,
  claudePath: string,
): string {
  if (DESKTOP_CLAUDE_COMMAND_TEMPLATE) {
    return DESKTOP_CLAUDE_COMMAND_TEMPLATE.replace(
      /\{dir\}/g,
      bashSingleQuotedPath(explicitPath),
    );
  }
  return `cd ${bashSingleQuotedPath(explicitPath)} && exec ${bashSingleQuotedPath(claudePath)} ${DESKTOP_CLAUDE_DEFAULT_ARGS}`;
}

/**
 * Pure dispatch from a `TerminalApp` to the argv needed to spawn a new
 * terminal window running `shellCommand` in `explicitPath`. Exported for
 * unit tests — prod code should call `openMacOSTerminalWithCommand`.
 */
export function buildTerminalSpawnArgs(
  terminalApp: TerminalApp,
  shellCommand: string,
  explicitPath: string,
): { argv: string[] } | { error: string } {
  switch (terminalApp) {
    case "ghostty":
      return {
        argv: [
          "open",
          "-na",
          "Ghostty.app",
          "--args",
          "-e",
          "/bin/sh",
          "-c",
          shellCommand,
        ],
      };
    case "cmux": {
      const cmuxBin = resolveCmuxBin();
      if (!cmuxBin) {
        return {
          error: "cmux CLI not found. Install cmux.app from https://cmux.dev",
        };
      }
      return {
        argv: [
          cmuxBin,
          "new-workspace",
          "--cwd",
          explicitPath,
          "--command",
          shellCommand,
        ],
      };
    }
    case "iterm2": {
      const esc = escapeAppleScriptDoubleQuoted(shellCommand);
      const script = [
        `tell application "iTerm2"`,
        `  activate`,
        `  tell (create window with default profile)`,
        `    tell current session of current tab of current window`,
        `      write text "${esc}"`,
        `    end tell`,
        `  end tell`,
        `end tell`,
      ].join("\n");
      return { argv: ["osascript", "-e", script] };
    }
    case "terminal":
      return {
        argv: [
          "osascript",
          "-e",
          `tell application "Terminal" to do script "${escapeAppleScriptDoubleQuoted(shellCommand)}"`,
        ],
      };
  }
}

/**
 * Open a desktop terminal with a shell command (macOS). Wraps
 * `buildTerminalSpawnArgs` + `Bun.spawnSync` for the live call site.
 */
function openMacOSTerminalWithCommand(
  shellCommand: string,
  explicitPath: string,
): {
  ok: boolean;
  stderr: string;
} {
  const built = buildTerminalSpawnArgs(
    getTerminal(),
    shellCommand,
    explicitPath,
  );
  if ("error" in built) {
    return { ok: false, stderr: built.error };
  }
  const r = Bun.spawnSync(built.argv);
  const stderr = (r.stderr ?? Buffer.alloc(0)).toString().trim();
  return { ok: r.exitCode === 0, stderr };
}

function relayIdentity(pf: {
  sessionId?: string;
  ppid?: number;
  pid: number;
}): string {
  if (pf.sessionId) return `session:${pf.sessionId}`;
  if (pf.ppid !== undefined) return `ppid:${pf.ppid}`;
  return `pid:${pf.pid}`;
}

/** Match relay port `cwd` to spawn target (symlinks / trailing slashes). */
function tryRealpathSync(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p.replace(/\/+$/, "") || p;
  }
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

  if (getTopicsEnabled()) {
    const topicHelp = [
      "<b>📱 Claude Mobile Bridge v2</b>",
      "",
      "Each session has its own topic. Send messages in a topic to talk to that session.",
      "",
      "<b>Session Management</b>",
      "/list — session dashboard",
      "/new [path] — spawn desktop Claude",
      "/sessions — browse offline sessions",
      "/kill — terminate session + delete topic",
      "",
      "<b>Session Commands (in topic or General)</b>",
      "/status — session details",
      "/model — switch model",
      "/stop — interrupt current query",
      "/retry — replay last message",
      "",
      "<b>Navigation (in topic)</b>",
      "/pwd — show working dir",
      "/cd — change working dir",
      "/ls — list directory",
      "/clear — clear session",
      "",
      "<b>Utilities</b>",
      "/usage — quota stats",
      "/execute — configured scripts",
      "/settings — bot settings",
      "/pin — update pinned status",
      "/restart — restart bot",
    ].join("\n");
    await ctx.reply(topicHelp, { parse_mode: "HTML" });
    return;
  }

  await ctx.reply(
    `📚 <b>Commands</b>\n\n` +
      `<b>Sessions:</b>\n` +
      `/list - Show all sessions\n` +
      `/switch &lt;name&gt; - Switch to session\n` +
      `/sessions - Browse offline sessions\n` +
      `/new [path] - Open desktop Claude (Terminal)\n\n` +
      `<b>Watch:</b>\n` +
      `/watch [name] - Watch desktop session live\n` +
      `/unwatch - Stop watching\n\n` +
      `<b>Control:</b>\n` +
      `/stop - Interrupt current query\n` +
      `/kill - Terminate a session (pick from list)\n` +
      `/retry - Retry last message\n` +
      `/status - Show session details\n` +
      `/model - Switch model\n` +
      `/restart - Restart bot\n\n` +
      `<b>Files:</b>\n` +
      `/pwd - Show working directory\n` +
      `/cd &lt;path&gt; - Change directory\n` +
      `/ls [path] - List directory\n\n` +
      `<b>Quota:</b>\n` +
      `/usage - Show session &amp; weekly usage\n\n` +
      `<b>Scripts:</b>\n` +
      `/execute - Start/stop configured scripts\n\n` +
      `<b>Settings:</b>\n` +
      `/settings - Persistent settings panel\n\n` +
      `<b>Tips:</b>\n` +
      `• Prefix with <code>!</code> to interrupt active query\n` +
      `• Say "think" for extended reasoning\n` +
      `• Send voice/photo/files directly\n` +
      `• Use /new to reset conversation`,
    { parse_mode: "HTML" },
  );
}

/**
 * Opens a macOS Terminal (or iTerm) in `explicitPath` running Claude with relay
 * flags, then waits for the channel relay and attaches watch — shared by /new and
 * /sessions → Resume.
 */
export async function spawnDesktopClaudeSession(
  api: Context["api"],
  chatId: number,
  explicitPath: string,
  userId: number,
): Promise<void> {
  const claudePath = await assertDesktopSpawnReady((text) =>
    api.sendMessage(chatId, text, { parse_mode: "HTML" }),
  );
  if (!claudePath) return;

  const opId = createOpId("spawn");
  const spawnStartedAt = Date.now();
  info("spawn: started", { opId, chatId, userId, explicitPath });

  try {
    try {
      await access(explicitPath);
    } catch {
      warn("spawn: cwd not found or inaccessible", {
        opId,
        chatId,
        userId,
        explicitPath,
        durationMs: elapsedMs(spawnStartedAt),
      });
      await api.sendMessage(
        chatId,
        "❌ That project path is missing or not readable on the machine running the bot.\n\n" +
          `<code>${escapeHtml(explicitPath)}</code>\n\n` +
          "Paths must exist on the Mac where the bot runs.",
        { parse_mode: "HTML" },
      );
      return;
    }

    const spawnCwd = tryRealpathSync(explicitPath);
    info("spawn: canonical cwd", { opId, spawnCwd });

    // Memoize realpath — `spawnCwd` is stable, but every port-file /
    // session `cwd` we compare against would otherwise be re-canonicalized
    // on every 2s poll iteration.
    const realpathCache = new Map<string, string>();
    const canonical = (p: string): string => {
      const hit = realpathCache.get(p);
      if (hit !== undefined) return hit;
      const r = tryRealpathSync(p);
      realpathCache.set(p, r);
      return r;
    };

    const [initialPortFiles, initialSessions] = await Promise.all([
      scanPortFiles(true),
      Promise.resolve(getSessions()),
    ]);
    const beforeRelays = initialPortFiles.filter(
      (pf) => canonical(pf.cwd) === spawnCwd,
    );
    const knownRelayIds = new Set(beforeRelays.map(relayIdentity));
    const beforeSessions = initialSessions.filter(
      (s) => canonical(s.dir) === spawnCwd,
    );
    const knownSessionIds = new Set(
      beforeSessions.map((s) => s.id).filter(Boolean),
    );
    const knownSessionPids = new Set(
      beforeSessions
        .map((s) => s.pid)
        .filter((pid): pid is number => pid !== undefined),
    );

    // Watcher would otherwise broadcast a redundant "🟢 online" for this
    // dir — spawn flow edits its own status bubble once the relay appears.
    // Suppression outlives the 120s poll deadline.
    suppressDirNotifications(spawnCwd, 150_000);

    const shellCmd = buildDesktopShellCommand(explicitPath, claudePath);
    const term = openMacOSTerminalWithCommand(shellCmd, explicitPath);
    if (!term.ok) {
      warn("spawn: osascript failed", {
        opId,
        chatId,
        userId,
        explicitPath,
        stderr: term.stderr.slice(0, 500),
        durationMs: elapsedMs(spawnStartedAt),
      });
      await api.sendMessage(
        chatId,
        "❌ Could not open Terminal.\n\n" +
          `<code>${escapeHtml(term.stderr || "osascript failed")}</code>`,
        { parse_mode: "HTML" },
      );
      return;
    }

    // setWorkingDir is deferred to the success branch — osascript can
    // report success even if Terminal silently fails to launch
    // (Accessibility denied, profile issue), so we only commit the dir
    // after a port file confirms a live claude in it.
    const statusMsg = await api.sendMessage(
      chatId,
      "⏳ Terminal opened — starting Claude.\n\n" +
        "<b>At the Mac:</b> if you see the development-channels menu, choose <b>1</b> (local development) and press Enter.\n\n" +
        "<b>Remote only:</b> set <code>DESKTOP_CLAUDE_COMMAND</code> to <code>…/scripts/claude-relay-launch.sh {dir}</code> (see README) so <code>expect</code> can send that for you.\n\n" +
        `Once the relay connects, <code>/pwd</code> and <code>/ls</code> will switch to this folder.\n\nWaiting for relay…`,
      { parse_mode: "HTML" },
    );
    const editStatus = (text: string): Promise<unknown> =>
      api
        .editMessageText(chatId, statusMsg.message_id, text, {
          parse_mode: "HTML",
        })
        .catch(() => {});

    await Bun.sleep(4000);

    const deadline = Date.now() + 120_000;
    let spawnedRelay: Awaited<ReturnType<typeof scanPortFiles>>[number] | null =
      null;
    while (Date.now() < deadline) {
      await Bun.sleep(2000);
      const portFiles = await scanPortFiles(true);
      const newRelays = portFiles.filter(
        (pf) =>
          canonical(pf.cwd) === spawnCwd &&
          !knownRelayIds.has(relayIdentity(pf)),
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
        await editStatus(
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
      await editStatus(
        "⚠️ Relay not detected in time (~2 min). In Terminal: finish login, approve dev channels, and ensure MCP <code>channel-relay</code> is registered for that shell. Then <code>/list</code> or <code>/watch</code>.",
      );
      return;
    }

    await forceRefresh();
    const sessions = getSessions();
    const dirSessions = sessions.filter((s) => canonical(s.dir) === spawnCwd);
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
      // Relay confirmed live — now safe to update working dir, activate
      // the session, and start watching.
      session.setWorkingDir(spawnCwd);
      setActiveSession(spawned.name);
      if (getAutoWatchOnSpawn()) {
        startWatchingSession(api, chatId, spawned.name, "spawn").catch(
          () => {},
        );
      }
      await editStatus(
        `✅ <b>${escapeHtml(spawned.name)}</b> ready — watching for updates.`,
      );

      // Create topic for the new session
      if (_topicManager && getTopicsEnabled()) {
        const topicId = await _topicManager.createTopic(spawned.name, spawnCwd);
        if (topicId) {
          await api.sendMessage(
            chatId,
            `🟢 Session started in <code>${escapeHtml(spawnCwd)}</code>`,
            {
              parse_mode: "HTML",
              message_thread_id: topicId,
            },
          );
        }
      }

      info("spawn: completed", {
        opId,
        chatId,
        userId,
        explicitPath,
        sessionName: spawned.name,
        sessionId: spawned.id,
        durationMs: elapsedMs(spawnStartedAt),
      });
    } else {
      warn("spawn: session unresolved after relay detection", {
        opId,
        chatId,
        userId,
        explicitPath,
        durationMs: elapsedMs(spawnStartedAt),
      });
      await editStatus(
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
    await api.sendMessage(
      chatId,
      `❌ Spawn failed: ${String(err).slice(0, 200)}`,
    );
  }
}

/**
 * /new [path] - Open Terminal (or iTerm) with Claude in the project directory.
 */
export async function handleNew(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (!chatId) return;

  const ready = await assertDesktopSpawnReady((t) =>
    ctx.reply(t, { parse_mode: "HTML" }),
  );
  if (!ready) return;

  const text = ctx.message?.text || "";
  const rawPath = text.split(/\s+/).slice(1).join(" ").trim();
  const explicitPath = rawPath
    ? resolve(getWorkingDir(), rawPath)
    : getWorkingDir();

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
  await ctx.reply(
    `🚀 Spawning desktop session...\n📁 <code>${escapeHtml(dir)}</code>`,
    {
      parse_mode: "HTML",
    },
  );

  await spawnDesktopClaudeSession(ctx.api, chatId, explicitPath, userId!);
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

  // Topic context: load session from topic or show picker in General
  if (getTopicsEnabled()) {
    const topicCtx = isSessionTopic(ctx);
    if (topicCtx) {
      const sessionInfo = getSession(topicCtx.sessionName);
      if (sessionInfo) session.loadFromRegistry(sessionInfo);
    } else if (isGeneralTopic(ctx)) {
      if (await showSessionPicker(ctx, "stop_pick")) return;
    }
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
  // Suppress notifications for this dir while the relay child winds down —
  // its lingering port file would otherwise be rediscovered as a new session.
  suppressDirNotifications(sessionInfo.dir);

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

  if (_topicManager && getTopicsEnabled()) {
    _topicManager
      .deleteTopic(sessionInfo.name)
      .catch((err) => warn(`kill: topic delete failed: ${err}`));
  }

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

  const sessions = getSessions();
  if (sessions.length === 0) {
    await ctx.reply("No active sessions.");
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

  // Topic context: load session from topic or show picker in General
  if (getTopicsEnabled()) {
    const topicCtx = isSessionTopic(ctx);
    if (topicCtx) {
      const sessionInfo = getSession(topicCtx.sessionName);
      if (sessionInfo) session.loadFromRegistry(sessionInfo);
    } else if (isGeneralTopic(ctx)) {
      if (await showSessionPicker(ctx, "status_pick")) return;
    }
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
    getWorkingDir()
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

  // Topic context: load session from topic or show picker in General
  if (getTopicsEnabled()) {
    const topicCtx = isSessionTopic(ctx);
    if (topicCtx) {
      const sessionInfo = getSession(topicCtx.sessionName);
      if (sessionInfo) session.loadFromRegistry(sessionInfo);
    } else if (isGeneralTopic(ctx)) {
      if (await showSessionPicker(ctx, "model_pick")) return;
    }
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
 * /restart - Restart the bot runner in-process.
 */
export async function handleRestart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const msg = await ctx.reply("🔄 Restarting...");

  try {
    triggerRestart();
    await ctx.api.editMessageText(msg.chat.id, msg.message_id, "✅ Restarted");
  } catch (e) {
    await ctx.api
      .editMessageText(msg.chat.id, msg.message_id, `❌ Restart failed: ${e}`)
      .catch(() => {});
  }
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

  if (getTopicsEnabled()) {
    // Topic mode: show sessions as status list (user navigates by opening topics)
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i]!;
      const hasRelay = relayDirSet.has(s.dir);
      const emoji = hasRelay ? "🟢" : "🔴";
      const dir = s.dir.replace(/^\/Users\/[^/]+/, "~");
      lines.push(
        `${emoji} <b>${escapeHtml(s.name)}</b>\n  <code>${escapeHtml(dir)}</code>`,
      );
      const branch = branches[i];
      if (branch) lines.push(`  🌿 ${escapeHtml(branch)}`);
      lines.push("");
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  } else {
    // v1 behavior: show sessions with Switch buttons
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

    const buttons = sessions.map((s) => [
      {
        text: active?.name === s.name ? `✓ ${s.name}` : s.name,
        callback_data: `switch:${s.name}`,
      },
    ]);

    await ctx.reply(lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup:
        buttons.length > 0 ? { inline_keyboard: buttons } : undefined,
    });

    // Auto-watch active desktop session if not already watching
    const chatId = ctx.chat?.id;
    if (chatId && active?.info.source === "desktop" && !isWatching(chatId)) {
      await startWatchingAndNotify(ctx, chatId, active.name, "list_auto");
    }
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

  if (getTopicsEnabled()) {
    await ctx.reply(
      "ℹ️ /switch is not needed with topics. Just open a session topic.",
    );
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

      // Auto-watch desktop sessions
      if (active.info.source === "desktop" && chatId) {
        if (
          !(await startWatchingAndNotify(ctx, chatId, active.name, "switch"))
        ) {
          await sendSwitchHistory(ctx, active.info);
          await ctx.reply(`✅ <code>${name}</code>\n📁 <code>${dir}</code>`, {
            parse_mode: "HTML",
          });
        }
      } else {
        await sendSwitchHistory(ctx, active.info);
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
 * /sessions - List offline Claude sessions with Resume buttons.
 */
export async function handleSessions(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (!chatId) return;

  const ready = await assertDesktopSpawnReady((t) =>
    ctx.reply(t, { parse_mode: "HTML" }),
  );
  if (!ready) return;

  const allSessions = await listOfflineSessions();

  if (allSessions.length === 0) {
    await ctx.reply(
      "📋 No offline sessions found.\n\nAll sessions are either live or have no history.",
    );
    return;
  }

  const sessions = allSessions.slice(0, MAX_OFFLINE_SESSIONS);
  const gen = ++offlineSessionGen;
  offlineSessionCache.set(chatId, { gen, sessions });

  const lines: string[] = ["📋 <b>Offline Sessions</b>\n"];

  for (const s of sessions) {
    const dir = s.dir.replace(/^\/Users\/[^/]+/, "~");
    const ago = formatTimeAgo(s.lastActivity);
    lines.push(`📁 <code>${escapeHtml(dir)}</code> · ${ago}`);
    if (s.lastMessage) {
      lines.push(`   <i>${escapeHtml(s.lastMessage)}</i>`);
    }
    lines.push("");
  }

  if (allSessions.length > sessions.length) {
    lines.push(
      `<i>Showing ${sessions.length} of ${allSessions.length} most recent.</i>`,
    );
  }

  const buttons = sessions.map((s, i) => [
    {
      text: s.dir.split("/").pop() || s.dir,
      callback_data: `sess_pick:${gen}:${i}`,
    },
  ]);

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });
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

  const dir = session.workingDir || getWorkingDir();
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
  const targetPath = resolve(session.workingDir || getWorkingDir(), rawPath);

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
    ? resolve(session.workingDir || getWorkingDir(), rawPath)
    : session.workingDir || getWorkingDir();

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
