/**
 * Photo message handler for Claude Telegram Bot.
 *
 * Supports single photos and media groups (albums) with 1s buffering.
 */

import type { Context } from "grammy";
import { ALLOWED_USERS, TEMP_DIR } from "../config";
import { getWorkingDir } from "../settings";
import { isAuthorized, rateLimiter } from "../security";
import { auditLog, auditLogRateLimit } from "../utils";
import { createMediaGroupBuffer } from "./media-group";
import { sendViaRelay } from "./relay-bridge";
import { isRelayAvailable } from "../relay";
import { getSession } from "../sessions";
import { getSessionState } from "../sessions/session-state";
import type { SessionContext } from "../sessions/context";
import {
  createOpId,
  debug,
  elapsedMs,
  error as logError,
  info,
  warn,
} from "../logger";
import { getMessageBus } from "../messaging";
import { isRalphLoopTopic } from "../ralph/store";

function busReply(
  ctx: Context,
  content: string,
  opts: { format?: "plain" | "html"; threadId?: number } = {},
): Promise<unknown> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return Promise.resolve();
  return getMessageBus().send({
    chatId,
    threadId: opts.threadId ?? ctx.message?.message_thread_id,
    content,
    format: opts.format ?? "plain",
  });
}

// Create photo-specific media group buffer
const photoBuffer = createMediaGroupBuffer({
  emoji: "📷",
  itemLabel: "photo",
  itemLabelPlural: "photos",
});

/**
 * Download a photo and return the local path.
 */
async function downloadPhoto(ctx: Context): Promise<string> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) {
    throw new Error("No photo in message");
  }

  // Get the largest photo
  const file = await ctx.getFile();

  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const photoPath = `${TEMP_DIR}/photo_${timestamp}_${random}.jpg`;

  // Download
  const response = await fetch(
    `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`,
  );
  const buffer = await response.arrayBuffer();
  await Bun.write(photoPath, buffer);

  return photoPath;
}

/**
 * Process photos via relay.
 */
async function processPhotos(
  ctx: Context,
  photoPaths: string[],
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number,
  opId: string,
  threadId?: number,
  sctx?: SessionContext,
): Promise<void> {
  const state =
    sctx && sctx.source === "cc"
      ? getSessionState(sctx.sessionName)
      : undefined;
  const stopProcessing = state ? state.startProcessing() : () => {};
  const requestStartedAt = Date.now();

  try {
    // Relay supports one image_path — send first photo, mention others in text
    const relayText =
      photoPaths.length === 1
        ? caption || "Please analyze this image"
        : `${caption || "Please analyze these images"}\n\nAdditional photos: ${photoPaths.slice(1).join(", ")}`;

    const relayResult = await sendViaRelay(
      ctx,
      relayText,
      username,
      chatId,
      photoPaths[0],
      opId,
      threadId,
      sctx,
    );
    if (relayResult === "delivered") {
      await auditLog(userId, username, "PHOTO_RELAY", relayText, "(via relay)");
      info("request: completed", {
        opId,
        requestKind: photoPaths.length === 1 ? "photo" : "photo_album",
        chatId,
        userId,
        session: sctx?.sessionName,
        topic: threadId,
        durationMs: elapsedMs(requestStartedAt),
        path: "relay",
        itemCount: photoPaths.length,
      });
      return;
    }

    warn("request: relay incomplete", {
      opId,
      requestKind: "photo",
      chatId,
      userId,
      session: sctx?.sessionName,
      topic: threadId,
      relayResult,
      durationMs: elapsedMs(requestStartedAt),
    });
    if (relayResult === "failed") {
      await busReply(
        ctx,
        "⚠️ Message was sent but the session stopped responding.\n" +
          "It may still be processing. Check /status or try again.",
        { threadId },
      );
    } else {
      await busReply(
        ctx,
        "❌ No desktop session found.\n\n" +
          "Use /new to spawn one, or /list to find existing sessions.",
        { threadId },
      );
    }
  } finally {
    stopProcessing();
  }
}

/**
 * Handle incoming photo messages.
 */
export async function handlePhoto(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const mediaGroupId = ctx.message?.media_group_id;

  if (!userId || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized. Contact the bot owner for access.");
    return;
  }

  // Ralph loop topic is output-only (invariant 2). It bypasses topic-store,
  // so sctx is undefined and the photo would fall through to default-session
  // routing without this guard.
  if (isRalphLoopTopic(chatId, ctx.message?.message_thread_id)) {
    await busReply(ctx, "🔁 loop topic is output-only.", {
      threadId: ctx.message?.message_thread_id,
    });
    return;
  }

  const threadId = sctx?.topicId;

  // Reject early in Cursor topics: the CC relay path can't reach Cursor's
  // Composer (no port file, no relay process), and sendViaRelay would
  // otherwise fall back to dir-match and silently route to an unrelated CC
  // session that happens to share the dir. Cursor doesn't currently accept
  // image attachments through the CDP bridge either.
  if (sctx?.source === "cursor") {
    await busReply(
      ctx,
      "❌ Photos aren't supported in Cursor topics yet — only text.",
      { threadId },
    );
    return;
  }

  // Sync per-session SessionState with the registry (task 7d). The singleton
  // is no longer warmed here.
  const state =
    sctx && sctx.source === "cc"
      ? getSessionState(sctx.sessionName)
      : undefined;
  if (sctx && state) {
    const si = getSession(sctx.sessionName);
    if (si) state.loadFromRegistry(si);
  }

  const opId = createOpId(mediaGroupId ? "photo_album" : "photo");
  info("request: started", {
    opId,
    requestKind: mediaGroupId ? "photo_album" : "photo",
    chatId,
    userId,
    username,
    session: sctx?.sessionName,
    topic: threadId,
  });

  // 2. Relay preflight — avoid download if no session exists.
  // Use the topic-resolved sctx when present; otherwise fall back only to
  // the streaming-SDK singleton's workingDir. We deliberately do NOT
  // consult getActiveSession() — that chases the most-recent global
  // session (often a Cursor session whose lastActivity gets bumped on
  // every CDP nudge) and mis-targeted the preflight.
  const relayUp = await isRelayAvailable({
    sessionId: sctx?.sessionId,
    sessionDir: sctx?.sessionDir || state?.workingDir || getWorkingDir(),
    claudePid: sctx?.sessionPid,
  });
  if (!relayUp) {
    await busReply(
      ctx,
      "❌ No desktop session found.\n\n" +
        "Use /new to spawn one, or /list to find existing sessions.",
      { threadId },
    );
    return;
  }

  // 3. For single photos, show status and rate limit early
  let statusMsg: Awaited<ReturnType<typeof ctx.reply>> | null = null;
  if (!mediaGroupId) {
    info("photo: received", {
      username,
      chatId,
      userId,
    });
    // Rate limit
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await busReply(
        ctx,
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`,
        { threadId },
      );
      return;
    }

    // Show status immediately. Kept as ctx.reply so the returned
    // message_id can be used by api.editMessageText/deleteMessage below;
    // the bus's send/edit pair would also work but requires plumbing
    // the id back through processPhotos. TODO(phase-2): convert when
    // the status-message lifecycle is refactored.
    statusMsg = await ctx.reply("📷 Processing image...", {
      message_thread_id: threadId,
    });
  }

  // 3. Download photo
  let photoPath: string;
  try {
    photoPath = await downloadPhoto(ctx);
  } catch (error) {
    logError("photo: download failed", error, {
      chatId,
      userId,
      username,
    });
    if (statusMsg) {
      const editRes = await getMessageBus().edit(statusMsg.message_id, {
        chatId: statusMsg.chat.id,
        content: "❌ Failed to download photo.",
        format: "plain",
      });
      if (!editRes.ok) {
        debug("photo: failed to edit status message", {
          chatId,
          messageId: statusMsg.message_id,
          reason: editRes.reason,
        });
        await busReply(ctx, "❌ Failed to download photo.", { threadId });
      }
    } else {
      await busReply(ctx, "❌ Failed to download photo.", { threadId });
    }
    return;
  }

  // 4. Single photo - process immediately
  if (!mediaGroupId && statusMsg) {
    await processPhotos(
      ctx,
      [photoPath],
      ctx.message?.caption,
      userId,
      username,
      chatId,
      opId,
      threadId,
      sctx,
    );

    // Clean up status message
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch (error) {
      debug("photo: failed to delete status message", {
        chatId: statusMsg.chat.id,
        messageId: statusMsg.message_id,
        err: String(error),
      });
    }
    return;
  }

  // 5. Media group - buffer with timeout
  if (!mediaGroupId) return; // TypeScript guard

  await photoBuffer.addToGroup(
    mediaGroupId,
    photoPath,
    ctx,
    userId,
    username,
    (groupCtx, items, groupCaption, groupUserId, groupUsername, groupChatId) =>
      processPhotos(
        groupCtx,
        items,
        groupCaption,
        groupUserId,
        groupUsername,
        groupChatId,
        opId,
        threadId,
        sctx,
      ),
  );
}
