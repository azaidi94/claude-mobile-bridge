/**
 * /rename <name> — rename the current session and its Telegram topic.
 *
 * Names are the bot's join key: the topic store, the watcher cache, the
 * SessionState map, live watches and the relay port file all key on it, so a
 * rename has to move every one of them together. Telegram is updated first;
 * if that fails nothing else changes. The port file is not written here —
 * the watcher's next refresh sees the renamed cache entry and writes it via
 * portFileNameUpdates (forceRefresh below makes that immediate).
 */

import type { Context } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { isAuthorized } from "../../security";
import { escapeHtml } from "../../formatting";
import { info, warn } from "../../logger";
import type { SessionContext } from "../../sessions/context";
import {
  getSession,
  renameSession,
  forceRefresh,
} from "../../sessions/watcher";
import {
  hasSessionState,
  renameSessionState,
} from "../../sessions/session-state";
import { getTopicBySession, updateTopicMapping } from "../../topics";
import { renameWatchesByName } from "../watch";
import {
  renameRelayClients,
  scanPortFiles,
  updatePortFile,
} from "../../relay/discovery";
import { busReply } from "./helpers";

/** Same shape the watcher generates (dir basenames): letters, digits, . _ - */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export function isValidSessionName(name: string): boolean {
  return NAME_RE.test(name);
}

export async function handleRename(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  if (!isAuthorized(ctx.from?.id, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  if (!sctx?.topicId) {
    await busReply(
      ctx,
      "❌ Run /rename inside the session topic you want to rename.",
    );
    return;
  }
  if (sctx.source !== "cc") {
    await busReply(ctx, "❌ /rename only supports Claude Code sessions.");
    return;
  }

  const newName = (ctx.message?.text ?? "")
    .split(/\s+/)
    .slice(1)
    .join(" ")
    .trim();
  if (!newName) {
    await busReply(ctx, "Usage: /rename &lt;name&gt;", "html");
    return;
  }
  if (!isValidSessionName(newName)) {
    await busReply(
      ctx,
      "❌ Name must be 1–40 chars: letters, digits, <code>. _ -</code>, starting with a letter or digit.",
      "html",
    );
    return;
  }
  const oldName = sctx.sessionName;
  if (newName === oldName) {
    await busReply(
      ctx,
      `ℹ️ Already named <b>${escapeHtml(oldName)}</b>.`,
      "html",
    );
    return;
  }
  if (
    getSession(newName) ||
    getTopicBySession(newName) ||
    hasSessionState(newName)
  ) {
    await busReply(
      ctx,
      `❌ <b>${escapeHtml(newName)}</b> is already in use.`,
      "html",
    );
    return;
  }

  // Telegram first — if this fails nothing else changes.
  try {
    await ctx.api.editForumTopic(chatId, sctx.topicId, { name: newName });
  } catch (e) {
    warn("rename: editForumTopic failed", {
      chatId,
      topic: sctx.topicId,
      session: oldName,
      err: String(e),
    });
    await busReply(
      ctx,
      `❌ Telegram refused the rename: <code>${escapeHtml(String(e))}</code>`,
      "html",
    );
    return;
  }

  // Cache before store: the topic store must never point at a name the
  // watcher cache doesn't hold, or routing for the topic breaks. If the cache
  // entry vanished (concurrent refresh) put the Telegram title back and stop.
  if (!renameSession(oldName, newName)) {
    await ctx.api
      .editForumTopic(chatId, sctx.topicId, { name: oldName })
      .catch(() => {});
    warn("rename: cache entry missing, reverted", {
      chatId,
      topic: sctx.topicId,
      session: oldName,
    });
    await busReply(
      ctx,
      "❌ Session changed underneath the rename; nothing was changed. Try again.",
    );
    return;
  }
  const stateRenamed = renameSessionState(oldName, newName);
  updateTopicMapping(oldName, { sessionName: newName });
  const watches = renameWatchesByName(oldName, newName, ctx.api);
  const relayClients = renameRelayClients(oldName, newName);

  // Relay port file: `sessionName` is what the watcher would write on its
  // next refresh anyway; `topicName` is only ever written at topic creation
  // and drives the post-/clear sessionId re-anchor, so it must move now.
  let portFile = false;
  try {
    const pfs = await scanPortFiles(true);
    const byId = pfs.filter(
      (pf) => pf.sessionId && pf.sessionId === sctx.sessionId,
    );
    const byDir = pfs.filter((pf) => pf.cwd === sctx.sessionDir);
    const pf = byId[0] ?? (byDir.length === 1 ? byDir[0] : undefined);
    if (pf) {
      await updatePortFile(pf.pid, {
        sessionName: newName,
        topicName: newName,
      });
      portFile = true;
    }
  } catch (e) {
    warn("rename: port file update failed", {
      session: newName,
      err: String(e),
    });
  }

  info("rename: session renamed", {
    chatId,
    topic: sctx.topicId,
    session: newName,
    from: oldName,
    stateRenamed,
    watches,
    relayClients,
    portFile,
  });
  forceRefresh().catch(() => {});

  await busReply(
    ctx,
    `✏️ Renamed <b>${escapeHtml(oldName)}</b> → <b>${escapeHtml(newName)}</b>.`,
    "html",
  );
}
