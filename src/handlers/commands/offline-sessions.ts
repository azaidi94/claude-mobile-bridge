/**
 * /sessions — offline Claude session picker.
 *
 * Hosts `offlineSessionCache` (also consumed by callback.ts when a
 * sess_pick: / sess_resume: callback fires).
 */

import type { Context } from "grammy";
import { escapeHtml, formatTimeAgo } from "../../formatting";
import { ALLOWED_USERS } from "../../config";
import { isAuthorized } from "../../security";
import type { OfflineSession } from "../../sessions/offline";
import { listOfflineSessions } from "../../sessions/offline";
import { assertDesktopSpawnReady, busReply } from "./helpers";

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

/**
 * /sessions - List offline Claude sessions with Resume buttons.
 */
export async function handleSessions(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  if (!chatId) return;

  const ready = await assertDesktopSpawnReady((t) => busReply(ctx, t, "html"));
  if (!ready) return;

  const allSessions = await listOfflineSessions();

  if (allSessions.length === 0) {
    await busReply(
      ctx,
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

  await busReply(ctx, lines.join("\n"), {
    format: "html",
    replyMarkup: { inline_keyboard: buttons },
  });
}
