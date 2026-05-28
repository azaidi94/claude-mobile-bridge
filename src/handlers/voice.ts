/**
 * Voice message handler for Claude Telegram Bot.
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { ALLOWED_USERS, TEMP_DIR, TRANSCRIPTION_AVAILABLE } from "../config";
import { getWorkingDir } from "../settings";
import { isAuthorized, rateLimiter } from "../security";
import {
  auditLog,
  auditLogRateLimit,
  transcribeVoice,
  startTypingIndicator,
} from "../utils";
import { sendViaRelay } from "./relay-bridge";
import { isRelayAvailable } from "../relay";
import { getSession } from "../sessions";
import { getSessionState } from "../sessions/session-state";
import type { SessionContext } from "../sessions/context";
import { createOpId, debug, elapsedMs, info, warn } from "../logger";
import { getMessageBus } from "../messaging";

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

/**
 * Handle incoming voice messages.
 */
export async function handleVoice(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const voice = ctx.message?.voice;

  if (!userId || !voice || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized. Contact the bot owner for access.");
    return;
  }

  const threadId = sctx?.topicId;

  // Cursor topics: no CC relay, no CDP voice channel — reject before paying
  // for transcription. Falling through would silently mis-route to whichever
  // CC session shares the dir.
  if (sctx?.source === "cursor") {
    await busReply(
      ctx,
      "❌ Voice messages aren't supported in Cursor topics yet — only text.",
      { threadId },
    );
    return;
  }

  // Sync per-session SessionState with the registry (task 7d).
  const state =
    sctx && sctx.source === "cc"
      ? getSessionState(sctx.sessionName)
      : undefined;
  if (sctx && state) {
    const si = getSession(sctx.sessionName);
    if (si) state.loadFromRegistry(si);
  }

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
    await busReply(
      ctx,
      "Voice transcription is not configured. Set OPENAI_API_KEY in .env",
      { threadId },
    );
    return;
  }

  // 3. Rate limit check
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

  // 4. Quick relay preflight — avoid transcription cost if no session exists.
  // Use the topic-resolved sctx when present; otherwise fall back to the
  // streaming-SDK singleton's workingDir. We avoid getActiveSession() —
  // it returns the globally most-recent session, often a Cursor session
  // whose lastActivity bumps on every CDP nudge.
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

  // 5. Mark processing started (allows /stop to work during transcription/classification)
  const stopProcessing = state ? state.startProcessing() : () => {};

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
    // TODO(phase-2 status-msg): keep ctx.reply — the returned Message is
    // edited later via api.editMessageText / deleted via api.deleteMessage,
    // and the bus does not yet return a Message-like stub.
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
      await getMessageBus().edit(statusMsg.message_id, {
        chatId,
        content: "❌ Transcription failed.",
        format: "plain",
      });
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
    await getMessageBus().edit(statusMsg.message_id, {
      chatId,
      content: `🎤 "${transcript}"`,
      format: "plain",
    });

    // 9. Send via relay
    const relayResult = await sendViaRelay(
      ctx,
      transcript,
      username,
      chatId,
      undefined,
      opId,
      threadId,
      sctx,
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
  } catch (error) {
    warn("voice: processing failed", {
      opId,
      chatId,
      userId,
      username,
      durationMs: elapsedMs(requestStartedAt),
      err: String(error).slice(0, 200),
    });
    await busReply(ctx, `❌ Error: ${String(error).slice(0, 200)}`, {
      threadId,
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
