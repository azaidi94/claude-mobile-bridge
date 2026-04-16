/**
 * Photo message handler for Claude Telegram Bot.
 *
 * Supports single photos and media groups (albums) with 1s buffering.
 */

import type { Context } from "grammy";
import { session } from "../session";
import { ALLOWED_USERS, TEMP_DIR } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import { auditLog, auditLogRateLimit } from "../utils";
import { createMediaGroupBuffer } from "./media-group";
import { sendViaRelay } from "./relay-bridge";
import { isRelayAvailable } from "../relay";
import { getActiveSession } from "../sessions";
import {
  createOpId,
  debug,
  elapsedMs,
  error as logError,
  info,
  warn,
} from "../logger";
import { loadTopicSession } from "../topics";
import type { SessionOverride } from "../sessions/types";

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
  sessionOverride?: SessionOverride,
): Promise<void> {
  const stopProcessing = session.startProcessing();
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
      sessionOverride,
    );
    if (relayResult === "delivered") {
      await auditLog(userId, username, "PHOTO_RELAY", relayText, "(via relay)");
      info("request: completed", {
        opId,
        requestKind: photoPaths.length === 1 ? "photo" : "photo_album",
        chatId,
        userId,
        durationMs: elapsedMs(requestStartedAt),
        path: "relay",
        itemCount: photoPaths.length,
      });
      return;
    }

    warn("request: relay " + relayResult, {
      opId,
      requestKind: "photo",
      chatId,
      userId,
      durationMs: elapsedMs(requestStartedAt),
    });
    if (relayResult === "failed") {
      await ctx.reply(
        "⚠️ Message was sent but the session stopped responding.\n" +
          "It may still be processing. Check /status or try again.",
        { message_thread_id: threadId },
      );
    } else {
      await ctx.reply(
        "❌ No desktop session found.\n\n" +
          "Use /new to spawn one, or /list to find existing sessions.",
        { message_thread_id: threadId },
      );
    }
  } finally {
    stopProcessing();
  }
}

/**
 * Handle incoming photo messages.
 */
export async function handlePhoto(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const mediaGroupId = ctx.message?.media_group_id;

  if (!userId || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  const { threadId, sessionOverride } = loadTopicSession(ctx) ?? {};

  const opId = createOpId(mediaGroupId ? "photo_album" : "photo");
  info("request: started", {
    opId,
    requestKind: mediaGroupId ? "photo_album" : "photo",
    chatId,
    userId,
    username,
  });

  // 2. Relay preflight — avoid download if no session exists
  const active = getActiveSession();
  const relayUp = await isRelayAvailable({
    sessionId: active?.info.id,
    sessionDir: session.workingDir || active?.info.dir,
    claudePid: active?.info.pid,
  });
  if (!relayUp) {
    await ctx.reply(
      "❌ No desktop session found.\n\n" +
        "Use /new to spawn one, or /list to find existing sessions.",
      { message_thread_id: threadId },
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
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`,
        { message_thread_id: threadId },
      );
      return;
    }

    // Show status immediately
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
      try {
        await ctx.api.editMessageText(
          statusMsg.chat.id,
          statusMsg.message_id,
          "❌ Failed to download photo.",
        );
      } catch (editError) {
        debug("photo: failed to edit status message", {
          chatId,
          messageId: statusMsg.message_id,
          err: String(editError),
        });
        await ctx.reply("❌ Failed to download photo.", {
          message_thread_id: threadId,
        });
      }
    } else {
      await ctx.reply("❌ Failed to download photo.", {
        message_thread_id: threadId,
      });
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
      sessionOverride,
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
        sessionOverride,
      ),
  );
}
