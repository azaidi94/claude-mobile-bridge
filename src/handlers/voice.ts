/**
 * Voice message handler for Claude Telegram Bot.
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { session } from "../session";
import { ALLOWED_USERS, TEMP_DIR, TRANSCRIPTION_AVAILABLE } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import {
  auditLog,
  auditLogRateLimit,
  transcribeVoice,
  startTypingIndicator,
} from "../utils";
import { sendViaRelay } from "./relay-bridge";
import { isRelayAvailable } from "../relay";
import { getActiveSession } from "../sessions";
import { createOpId, debug, elapsedMs, info, warn } from "../logger";
import { isSessionTopic } from "../topics";

/**
 * Handle incoming voice messages.
 */
export async function handleVoice(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const voice = ctx.message?.voice;

  if (!userId || !voice || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  const topicCtx = isSessionTopic(ctx);
  const threadId = topicCtx?.topicId;

  const opId = createOpId("voice");
  const requestStartedAt = Date.now();
  info("request: started", {
    opId,
    requestKind: "voice",
    chatId,
    userId,
    username,
  });

  // 2. Check if transcription is available
  if (!TRANSCRIPTION_AVAILABLE) {
    await ctx.reply(
      "Voice transcription is not configured. Set OPENAI_API_KEY in .env",
      { message_thread_id: threadId },
    );
    return;
  }

  // 3. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`,
      { message_thread_id: threadId },
    );
    return;
  }

  // 4. Quick relay preflight — avoid transcription cost if no session exists
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

  // 5. Mark processing started (allows /stop to work during transcription/classification)
  const stopProcessing = session.startProcessing();

  // 5. Start typing indicator for transcription
  const typing = startTypingIndicator(ctx);

  let voicePath: string | null = null;

  try {
    // 6. Download voice file
    const file = await ctx.getFile();
    const timestamp = Date.now();
    voicePath = `${TEMP_DIR}/voice_${timestamp}.ogg`;

    // Download the file
    const downloadRes = await fetch(
      `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`,
    );
    const buffer = await downloadRes.arrayBuffer();
    await Bun.write(voicePath, buffer);

    // 7. Transcribe
    const statusMsg = await ctx.reply("🎤 Transcribing...", {
      message_thread_id: threadId,
    });

    const transcriptionStartedAt = Date.now();
    const transcript = await transcribeVoice(voicePath);
    if (!transcript) {
      warn("transcription: no transcript", {
        opId,
        chatId,
        userId,
        durationMs: elapsedMs(transcriptionStartedAt),
      });
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        "❌ Transcription failed.",
      );
      stopProcessing();
      return;
    }
    info("transcription: completed", {
      opId,
      chatId,
      userId,
      durationMs: elapsedMs(transcriptionStartedAt),
      transcriptLength: transcript.length,
    });

    // 8. Show transcript
    await ctx.api.editMessageText(
      chatId,
      statusMsg.message_id,
      `🎤 "${transcript}"`,
    );

    // 9. Send via relay
    const relayResult = await sendViaRelay(
      ctx,
      transcript,
      username,
      chatId,
      undefined,
      opId,
      threadId,
    );
    if (relayResult === "delivered") {
      await auditLog(
        userId,
        username,
        "VOICE_RELAY",
        transcript,
        "(via relay)",
      );
      info("request: completed", {
        opId,
        requestKind: "voice",
        chatId,
        userId,
        durationMs: elapsedMs(requestStartedAt),
        path: "relay",
      });
      return;
    }

    warn("request: relay " + relayResult, {
      opId,
      requestKind: "voice",
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
  } catch (error) {
    warn("voice: processing failed", {
      opId,
      chatId,
      userId,
      username,
      durationMs: elapsedMs(requestStartedAt),
      err: String(error).slice(0, 200),
    });
    await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`, {
      message_thread_id: threadId,
    });
  } finally {
    stopProcessing();
    typing.stop();

    // Clean up voice file
    if (voicePath) {
      try {
        unlinkSync(voicePath);
      } catch (error) {
        debug("voice: failed to delete temp file", {
          path: voicePath,
          err: String(error),
        });
      }
    }
  }
}
