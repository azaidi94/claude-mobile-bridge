/**
 * Session-management commands: /list, /switch, /new, /sessions, /kill, /respawn.
 *
 * Hosts `offlineSessionCache` (also consumed by callback.ts) and the shared
 * `killSession` / `respawnSession` helpers used by their command handlers and
 * the kill: / respawn: callbacks.
 */

import { resolve } from "path";
import { stat } from "fs/promises";
import type { Context } from "grammy";
import { escapeHtml, formatTimeAgo } from "../../formatting";
import { ALLOWED_USERS } from "../../config";
import { getWorkingDir } from "../../settings";
import { isAuthorized, isPathAllowed } from "../../security";
import { isGeneralTopic } from "../../topics";
import {
  getSessions,
  getSession,
  removeSession,
  getGitBranch,
  suppressDirNotifications,
} from "../../sessions";
import type { SessionInfo } from "../../sessions/types";
import {
  getSessionState,
  dropSessionState,
} from "../../sessions/session-state";
import { disconnectRelay } from "../../relay";
import { stopWatchByName } from "../watch";
import { info, warn } from "../../logger";
import {
  assertDesktopSpawnReady,
  busReply,
  getTopicManager,
  isTopicChat,
  showSessionPicker,
} from "./helpers";
import { spawnDesktopClaudeSession } from "./spawn";

/**
 * /new [path] - Open Terminal (or iTerm) with Claude in the project directory.
 */
export async function handleNew(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  if (!chatId) return;

  const ready = await assertDesktopSpawnReady((t) => busReply(ctx, t, "html"));
  if (!ready) return;

  const text = ctx.message?.text || "";
  const rawPath = text.split(/\s+/).slice(1).join(" ").trim();
  const explicitPath = rawPath
    ? resolve(getWorkingDir(), rawPath)
    : getWorkingDir();

  if (!isPathAllowed(explicitPath)) {
    await busReply(ctx, "❌ Path not in allowed directories.");
    return;
  }

  try {
    const s = await stat(explicitPath);
    if (!s.isDirectory()) {
      await busReply(ctx, "❌ Not a directory.");
      return;
    }
  } catch {
    await busReply(ctx, "❌ Path does not exist.");
    return;
  }

  const dir = explicitPath.replace(/^\/Users\/[^/]+/, "~");
  await busReply(
    ctx,
    `🚀 Spawning desktop session...\n📁 <code>${escapeHtml(dir)}</code>`,
    "html",
  );

  await spawnDesktopClaudeSession(ctx.api, chatId, explicitPath, userId!);
}

/**
 * Kill a session by SIGTERM, clean up relay/watch/cache.
 * Shared by /kill command and kill: callback.
 *
 * `preserveTopic`: skip Telegram topic deletion so /respawn can reuse it
 * when a new session spawns into the same cwd with the same name.
 */
export async function killSession(
  sessionInfo: SessionInfo,
  chatId: number,
  botApi: Context["api"],
  opts: { preserveTopic?: boolean } = {},
): Promise<{ killed: boolean; pid?: number }> {
  stopWatchByName(sessionInfo.name, botApi, "kill");
  disconnectRelay({
    sessionDir: sessionInfo.dir,
    sessionId: sessionInfo.id || undefined,
    claudePid: sessionInfo.pid,
  });
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

  // Tear down per-session SessionState. Always do this so a recreated session
  // by the same name starts with a clean state.
  const perState = getSessionState(sessionInfo.name);
  if (perState.isRunning) {
    await perState.stop();
    await Bun.sleep(100);
    perState.clearStopRequested();
  }
  await perState.kill();
  dropSessionState(sessionInfo.name);

  removeSession(sessionInfo.name);

  const tm = getTopicManager();
  if (tm && !opts.preserveTopic) {
    tm.deleteTopic(sessionInfo.name).catch((err) =>
      warn(`kill: topic delete failed: ${err}`),
    );
  }

  info("kill: terminated", {
    sessionName: sessionInfo.name,
    sessionDir: sessionInfo.dir,
    pid,
    preserveTopic: Boolean(opts.preserveTopic),
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
    await busReply(ctx, "No sessions available. Use /new to start one.");
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

  await busReply(ctx, lines.join("\n"), {
    format: "html",
    replyMarkup: { inline_keyboard: buttons },
  });
}

/**
 * /kill [name] - Terminate a Claude session.
 */
export async function handleKill(
  ctx: Context,
  sctx?: import("../../sessions/context").SessionContext,
): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  if (!chatId) return;

  // Topic context: kill the topic's session directly, show picker in General
  if (sctx) {
    const sessionInfo = getSession(sctx.sessionName);
    if (sessionInfo) {
      const { pid } = await killSession(sessionInfo, chatId, ctx.api);
      const pidStr = pid ? ` (PID ${pid})` : "";
      await busReply(
        ctx,
        `💀 Killed <b>${escapeHtml(sessionInfo.name)}</b>${pidStr}`,
        "html",
      );
      return;
    }
  }

  const sessions = getSessions();
  if (sessions.length === 0) {
    await busReply(ctx, "No active sessions.");
    return;
  }
  await sendPostKillSessionList(ctx, chatId, "kill");
}

/**
 * Kill + re-spawn `target` in the same cwd. Watch and relay re-attach via
 * `spawnDesktopClaudeSession`. Shared by /respawn and the respawn: callback.
 *
 * Caller owns the user-facing "respawning…" status message — handleRespawn
 * sends a new one, the callback path edits its existing keyboard message.
 *
 * Old desktop Claude's port file is distinguished from the new one by
 * `relayIdentity` (sessionId/ppid/pid), so spawn's "before" snapshot doesn't
 * need to wait for the SIGTERM'd process to unlink — a stale port file in
 * `beforeRelays` only adds it to the known set, and the new relay is detected
 * regardless.
 */
export async function respawnSession(
  api: Context["api"],
  chatId: number,
  userId: number,
  target: SessionInfo,
): Promise<void> {
  const cwd = target.dir;
  const sessionName = target.name;

  await killSession(target, chatId, api, { preserveTopic: true });
  await spawnDesktopClaudeSession(api, chatId, cwd, userId);

  // Spawn flow's createTopic reuses the preserved mapping when the new
  // session shares a name. Otherwise — basename collision OR spawn failed —
  // the old mapping is stale; clean it up so it doesn't linger.
  const tm = getTopicManager();
  if (tm) {
    const newSession = getSession(sessionName);
    if (!newSession) {
      tm.deleteTopic(sessionName).catch((err) =>
        warn(`respawn: stale topic delete failed: ${err}`),
      );
    }
  }
}

/**
 * /respawn - Kill and re-spawn the current session in the same cwd.
 */
export async function handleRespawn(
  ctx: Context,
  sctx?: import("../../sessions/context").SessionContext,
): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }
  if (!chatId || userId === undefined) return;

  let target: SessionInfo | null = null;
  if (sctx) {
    target = getSession(sctx.sessionName);
    if (!target) {
      await busReply(ctx, "Session not found for this topic.");
      return;
    }
  } else if (isTopicChat(ctx) && isGeneralTopic(ctx)) {
    if (await showSessionPicker(ctx, "respawn")) return;
  }
  if (!target) {
    // Fallback for the General-topic / DM path with a single session in the
    // registry. With multiple sessions present, the picker shown above
    // already returned early.
    const sessions = getSessions();
    if (sessions.length === 1) target = sessions[0]!;
  }

  if (!target) {
    await busReply(ctx, "No active session to respawn. Use /new to start one.");
    return;
  }

  await busReply(
    ctx,
    `♻️ Respawning <b>${escapeHtml(target.name)}</b>...`,
    "html",
  );
  await respawnSession(ctx.api, chatId, userId, target);
}

/**
 * /list - Show all sessions with switch buttons.
 */
export async function handleList(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  const sessions = getSessions();

  if (sessions.length === 0) {
    await busReply(
      ctx,
      "📋 No sessions\n\nStart Claude Code to see sessions here.",
    );
    return;
  }

  // Tiny title + one Switch button per session. No per-session meta text —
  // the buttons are the selector (same treatment as /cursor).
  const buttons = sessions.map((s) => [
    { text: s.name, callback_data: `switch:${s.name}` },
  ]);

  await busReply(ctx, "📋 <b>Sessions</b>", {
    format: "html",
    replyMarkup: { inline_keyboard: buttons },
  });
}
