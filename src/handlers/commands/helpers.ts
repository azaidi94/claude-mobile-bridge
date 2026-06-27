/**
 * Shared helpers for the per-domain command modules.
 *
 * Owns the module-level topic-manager reference (`_topicManager`),
 * the bus-routed reply helper, the session picker / topic resolver,
 * and a few small generic command handlers that don't fit elsewhere
 * (/start, /help, /refresh, /groupmode).
 */

import { access } from "fs/promises";
import { realpathSync } from "fs";
import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  ALLOWED_USERS,
  findClaudeCli,
  isDesktopClaudeSpawnSupported,
} from "../../config";
import { isGeneralTopic, isSessionTopic } from "../../topics";
import type { TopicManager } from "../../topics";
import { isAuthorized } from "../../security";
import { getSessions, getSession, forceRefresh } from "../../sessions";
import { getSessionState } from "../../sessions/session-state";
import type { SessionContext } from "../../sessions/context";
import { getMessageBus } from "../../messaging";

/**
 * Bus-routed reply helper. Replaces direct grammy reply calls for plain or
 * HTML text and inline keyboards. Callers stay on grammy directly when they
 * need link_preview_options, reply_parameters, or non-inline reply markup
 * (e.g. ReplyKeyboardMarkup).
 *
 * Overloads accept either a `format` string or an options bag with
 * `replyMarkup` for inline keyboards.
 */
export function busReply(
  ctx: Context,
  content: string,
  formatOrOpts:
    | "plain"
    | "html"
    | {
        format?: "plain" | "html";
        replyMarkup?: import("grammy/types").InlineKeyboardMarkup;
      } = "plain",
): Promise<unknown> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return Promise.resolve();
  const opts =
    typeof formatOrOpts === "string" ? { format: formatOrOpts } : formatOrOpts;
  return getMessageBus().send({
    chatId,
    threadId: ctx.message?.message_thread_id,
    content,
    format: opts.format ?? "plain",
    replyMarkup: opts.replyMarkup,
  });
}

// Topic manager reference — set by index.ts when topics are enabled
let _topicManager: TopicManager | null = null;

export function setTopicManager(tm: TopicManager): void {
  _topicManager = tm;
}

export function getTopicManager(): TopicManager | null {
  return _topicManager;
}

/** True when topics are active AND the message is from the forum group. */
export function isTopicChat(ctx: Context): boolean {
  return _topicManager !== null && ctx.chat?.type === "supergroup";
}

/**
 * Show a session picker keyboard when in General topic with multiple sessions.
 * Returns true if a picker was shown (caller should return early).
 */
export async function showSessionPicker(
  ctx: Context,
  action: string,
): Promise<boolean> {
  if (!isTopicChat(ctx) || !isGeneralTopic(ctx)) return false;

  const sessions = getSessions();
  if (sessions.length === 0) {
    await busReply(ctx, "No active sessions.");
    return true;
  }
  if (sessions.length === 1) {
    return false; // Only one session — proceed with it
  }

  const keyboard = new InlineKeyboard();
  for (const s of sessions) {
    keyboard.text(s.name, `${action}:${s.name}`).row();
  }
  await busReply(ctx, "Pick a session:", { replyMarkup: keyboard });
  return true;
}

/**
 * Resolve topic session context: load session from topic, or show picker in General.
 * Returns true if caller should return early (picker shown or no session).
 */
export async function resolveTopicSession(
  ctx: Context,
  pickerAction: string,
): Promise<boolean> {
  if (!isTopicChat(ctx)) return false;
  const topicCtx = isSessionTopic(ctx);
  if (topicCtx) {
    const sessionInfo = getSession(topicCtx.sessionName);
    if (sessionInfo) {
      getSessionState(sessionInfo.name).loadFromRegistry(sessionInfo);
    }
    return false;
  }
  if (isGeneralTopic(ctx)) {
    return showSessionPicker(ctx, pickerAction);
  }
  return false;
}

export function bashSingleQuotedPath(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

export function escapeAppleScriptDoubleQuoted(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function resolveClaudePathForSpawn(): Promise<string | null> {
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
export async function assertDesktopSpawnReady(
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

export function relayIdentity(pf: {
  sessionId?: string;
  ppid?: number;
  pid: number;
}): string {
  if (pf.sessionId) return `session:${pf.sessionId}`;
  if (pf.ppid !== undefined) return `ppid:${pf.ppid}`;
  return `pid:${pf.pid}`;
}

/** Match relay port `cwd` to spawn target (symlinks / trailing slashes). */
export function tryRealpathSync(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p.replace(/\/+$/, "") || p;
  }
}

/**
 * /start - Show welcome message and status.
 */
export async function handleStart(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized. Contact the bot owner for access.");
    return;
  }

  const sessionName = sctx?.sessionName ?? getSessions()[0]?.name ?? "none";

  await busReply(
    ctx,
    `🤖 <b>Claude Coding Bot</b>\n\n` +
      `Active: <code>${sessionName}</code>\n\n` +
      `Use /help for commands`,
    "html",
  );
}

/**
 * /help - Show detailed help.
 */
export async function handleHelp(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  if (isTopicChat(ctx)) {
    const topicHelp = [
      "<b>📱 Claude Mobile Bridge v2</b>",
      "",
      "Each session has its own topic. Send messages in a topic to talk to that session.",
      "",
      "<b>Session Management</b>",
      "/list — session dashboard",
      "/new [path] — spawn desktop Claude",
      "/respawn — kill + restart current session, same cwd",
      "/sessions — browse offline sessions",
      "/kill — terminate session + delete topic",
      "",
      "<b>Session Commands (in topic or General)</b>",
      "/status — session details",
      "/model — switch model",
      "/stop — interrupt current query",
      "/retry — replay last message",
      "/run &lt;prompt&gt; — async, ping when done",
      "",
      "<b>Navigation (in topic)</b>",
      "/pwd — show working dir",
      "/cd — change working dir",
      "/ls — list directory",
      "",
      "<b>Inject (into the desktop TUI)</b>",
      "/clear — send /clear",
      "/compact — send /compact",
      "",
      "<b>Utilities</b>",
      "/usage — quota stats",
      "/execute — configured scripts",
      "/settings — bot settings",
      "/pin — update pinned status",
      "/restart — restart bot",
    ].join("\n");
    await busReply(ctx, topicHelp, "html");
    return;
  }

  await busReply(
    ctx,
    `📚 <b>Commands</b>\n\n` +
      `<b>Sessions:</b>\n` +
      `/list - Show all sessions\n` +
      `/switch &lt;name&gt; - Switch to session\n` +
      `/sessions - Browse offline sessions\n` +
      `/new [path] - Open desktop Claude (Terminal)\n` +
      `/respawn - Kill + restart current session, same cwd\n\n` +
      `<b>Watch:</b>\n` +
      `/watch [name] - Watch desktop session live\n` +
      `/unwatch - Stop watching\n\n` +
      `<b>Control:</b>\n` +
      `/stop - Interrupt current query\n` +
      `/kill - Terminate a session (pick from list)\n` +
      `/retry - Retry last message\n` +
      `/run &lt;prompt&gt; - Async — fire prompt, ping when done\n` +
      `/status - Show session details\n` +
      `/model - Switch model\n` +
      `/clear - Send /clear to the desktop session\n` +
      `/compact - Send /compact to the desktop session\n` +
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
    "html",
  );
}

/**
 * /refresh - Force refresh sessions (hidden command for debugging).
 */
export async function handleRefresh(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  await forceRefresh();
  const sessions = getSessions();
  await busReply(ctx, `🔄 Refreshed. Found ${sessions.length} session(s).`);
}
