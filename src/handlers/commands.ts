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
import { session, MODEL_DISPLAY_NAMES, type ModelId } from "../session";
import {
  WORKING_DIR,
  ALLOWED_USERS,
  RESTART_FILE,
  CLAUDE_CLI_PATH,
  isDesktopClaudeSpawnSupported,
  DESKTOP_CLAUDE_DEFAULT_ARGS,
  DESKTOP_CLAUDE_COMMAND_TEMPLATE,
  DESKTOP_TERMINAL_APP,
} from "../config";
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

function bashSingleQuotedPath(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function escapeAppleScriptDoubleQuoted(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function resolveClaudePathForSpawn(): Promise<string | null> {
  try {
    await access(CLAUDE_CLI_PATH);
    return CLAUDE_CLI_PATH;
  } catch {
    return Bun.which("claude");
  }
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
 * Pure dispatch: map a `DESKTOP_TERMINAL_APP` value to the argv needed to
 * spawn a new terminal window running `shellCommand` in `explicitPath`.
 *
 * Returns `{ argv }` on success, or `{ error }` if the terminal is
 * unavailable (e.g. cmux CLI missing). Exported for unit tests — prod code
 * should call `openMacOSTerminalWithCommand`.
 *
 * Dispatches on the (case-insensitive) app name:
 * - `terminal` (default) / `iterm` / `iterm2` → AppleScript via `osascript`
 * - `ghostty` → `open -na Ghostty.app --args -e /bin/sh -c <cmd>`
 * - `cmux`    → `<cmuxBin> new-workspace --cwd <dir> --command <cmd>`
 *
 * For `ghostty` and `cmux`, the shellCommand is passed as a separate argv
 * (no AppleScript escaping needed). cmux's `--command` types the text into
 * the new workspace's shell + presses Enter — same shape as iTerm's
 * `write text` and Terminal's `do script`.
 */
export function buildTerminalSpawnArgs(
  terminalApp: string,
  shellCommand: string,
  explicitPath: string,
): { argv: string[] } | { error: string } {
  const app = terminalApp.toLowerCase();

  if (app === "ghostty") {
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
  }

  if (app === "cmux") {
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

  let script: string;
  if (app === "iterm" || app === "iterm2") {
    const esc = escapeAppleScriptDoubleQuoted(shellCommand);
    script = [
      `tell application "iTerm2"`,
      `  activate`,
      `  tell (create window with default profile)`,
      `    tell current session of current tab of current window`,
      `      write text "${esc}"`,
      `    end tell`,
      `  end tell`,
      `end tell`,
    ].join("\n");
  } else {
    script = `tell application "Terminal" to do script "${escapeAppleScriptDoubleQuoted(shellCommand)}"`;
  }
  return { argv: ["osascript", "-e", script] };
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
    DESKTOP_TERMINAL_APP,
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
      `<b>Tips:</b>\n` +
      `• Prefix with <code>!</code> to interrupt active query\n` +
      `• Prefix with <code>//</code> to forward slash commands to Claude (e.g. <code>//clear</code>, <code>//compact</code>)\n` +
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
  if (!isDesktopClaudeSpawnSupported()) {
    await api.sendMessage(
      chatId,
      "❌ Desktop Claude spawn only works on <b>macOS</b> (opens Terminal / iTerm).",
      { parse_mode: "HTML" },
    );
    return;
  }

  const claudePath = await resolveClaudePathForSpawn();
  if (!claudePath) {
    await api.sendMessage(
      chatId,
      "❌ Claude CLI not found. Install Claude Code or set <code>CLAUDE_CLI_PATH</code>.",
      { parse_mode: "HTML" },
    );
    return;
  }

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

    const beforeRelays = (await scanPortFiles(true)).filter(
      (pf) => tryRealpathSync(pf.cwd) === spawnCwd,
    );
    const knownRelayIds = new Set(beforeRelays.map(relayIdentity));
    const beforeSessions = getSessions().filter(
      (s) => tryRealpathSync(s.dir) === spawnCwd,
    );
    const knownSessionIds = new Set(
      beforeSessions.map((s) => s.id).filter(Boolean),
    );
    const knownSessionPids = new Set(
      beforeSessions
        .map((s) => s.pid)
        .filter((pid): pid is number => pid !== undefined),
    );

    // Suppress the background watcher's redundant "🟢 online" broadcast for
    // this dir during the whole spawn window — the spawn flow edits its own
    // status message in place once the relay appears. 150s is slightly more
    // than the 120s deadline below so the suppression outlives it.
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

    // Send the initial "Waiting for relay…" status and remember its
    // message_id so every terminal state (success / timeout / ambiguous /
    // unresolved) can edit this bubble in place instead of stacking new
    // messages on top of a stale "Waiting…" banner.
    //
    // NB: we do NOT call session.setWorkingDir here. osascript can report
    // success even if Terminal silently fails to launch (Accessibility
    // denied, profile issue, etc.), so the working dir only gets updated
    // in the success branch below — after the relay port file confirms a
    // live claude process in that directory.
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
          tryRealpathSync(pf.cwd) === spawnCwd &&
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
    const dirSessions = sessions.filter(
      (s) => tryRealpathSync(s.dir) === spawnCwd,
    );
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
      startWatchingSession(api, chatId, spawned.name, "spawn").catch(() => {});
      await editStatus(
        `✅ <b>${escapeHtml(spawned.name)}</b> ready — watching for updates.`,
      );
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

  if (!isDesktopClaudeSpawnSupported()) {
    await ctx.reply(
      "❌ <b>macOS required</b>\n\n<code>/new</code> opens Terminal or iTerm on this machine.",
      { parse_mode: "HTML" },
    );
    return;
  }

  if (!(await resolveClaudePathForSpawn())) {
    await ctx.reply(
      "❌ Claude CLI not found. Install Claude Code or set <code>CLAUDE_CLI_PATH</code>.",
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

  if (!isDesktopClaudeSpawnSupported()) {
    await ctx.reply(
      "❌ <b>macOS required</b>\n\n<code>/sessions</code> → Resume opens Terminal on this machine.",
      { parse_mode: "HTML" },
    );
    return;
  }

  if (!(await resolveClaudePathForSpawn())) {
    await ctx.reply(
      "❌ Claude CLI not found. Install Claude Code or set <code>CLAUDE_CLI_PATH</code>.",
      { parse_mode: "HTML" },
    );
    return;
  }

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
