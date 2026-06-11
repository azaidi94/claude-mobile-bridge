/**
 * Utility functions for Claude Telegram Bot.
 *
 * Audit logging, voice transcription, typing indicator.
 */

import OpenAI from "openai";
import type { Chat } from "grammy/types";
import type { Context } from "grammy";
import type { AuditEvent } from "./types";
import {
  AUDIT_LOG_PATH,
  AUDIT_LOG_JSON,
  OPENAI_API_KEY,
  TRANSCRIPTION_PROMPT,
  TRANSCRIPTION_AVAILABLE,
} from "./config";
import { debug, error as logError, info, warn } from "./logger";

// ============== OpenAI Client ==============

let openaiClient: OpenAI | null = null;
if (OPENAI_API_KEY && TRANSCRIPTION_AVAILABLE) {
  openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
}

// ============== Audit Logging ==============

async function writeAuditLog(event: AuditEvent): Promise<void> {
  try {
    let content: string;
    if (AUDIT_LOG_JSON) {
      content = JSON.stringify(event) + "\n";
    } else {
      // Plain text format for readability
      const lines = ["\n" + "=".repeat(60)];
      for (const [key, value] of Object.entries(event)) {
        let displayValue = value;
        if (
          (key === "content" || key === "response") &&
          String(value).length > 500
        ) {
          displayValue = String(value).slice(0, 500) + "...";
        }
        lines.push(`${key}: ${displayValue}`);
      }
      content = lines.join("\n") + "\n";
    }

    // Append to audit log file
    const fs = await import("fs/promises");
    await fs.appendFile(AUDIT_LOG_PATH, content);
  } catch (error) {
    logError("audit: write failed", error, { path: AUDIT_LOG_PATH });
  }
}

export async function auditLog(
  userId: number,
  username: string,
  messageType: string,
  content: string,
  response = "",
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "message",
    user_id: userId,
    username,
    message_type: messageType,
    content,
  };
  if (response) {
    event.response = response;
  }
  await writeAuditLog(event);
}

export async function auditLogRateLimit(
  userId: number,
  username: string,
  retryAfter: number,
): Promise<void> {
  await writeAuditLog({
    timestamp: new Date().toISOString(),
    event: "rate_limit",
    user_id: userId,
    username,
    retry_after: retryAfter,
  });
}

// ============== Voice Transcription ==============

export async function transcribeVoice(
  filePath: string,
): Promise<string | null> {
  if (!openaiClient) {
    warn("transcription: client unavailable");
    return null;
  }

  try {
    const file = Bun.file(filePath);
    const transcript = await openaiClient.audio.transcriptions.create({
      model: "gpt-4o-transcribe",
      file: file,
      prompt: TRANSCRIPTION_PROMPT,
    });
    return transcript.text;
  } catch (error) {
    logError("transcription: failed", error, { path: filePath });
    return null;
  }
}

// ============== Typing Indicator ==============

export interface TypingController {
  stop: () => void;
}

export function startTypingIndicator(ctx: Context): TypingController {
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        await ctx.replyWithChatAction("typing");
      } catch (error) {
        debug("typing: send failed", {
          chatId: ctx.chat?.id,
          err: String(error),
        });
      }
      await Bun.sleep(4000);
    }
  };

  // Start the loop
  loop();

  return {
    stop: () => {
      running = false;
    },
  };
}

// ============== Message Interrupt ==============

/**
 * Minimal shape we need from a session-like object for the interrupt path.
 * Satisfied by `SessionState` — kept here so this module doesn't depend on
 * the session module directly.
 */
interface InterruptTarget {
  isRunning: boolean;
  stop: () => Promise<"stopped" | "pending" | false>;
  markInterrupt: () => void;
  clearStopRequested: () => void;
}

/**
 * Strip a leading `!` from `text`; if present and a query is running on the
 * supplied target, interrupt it. `state` is required for the interrupt path
 * — without it the `!` is just stripped and the call is a no-op.
 */
export async function checkInterrupt(
  text: string,
  state?: InterruptTarget,
): Promise<string> {
  if (!text || !text.startsWith("!")) {
    return text;
  }

  const strippedText = text.slice(1).trimStart();

  if (state && state.isRunning) {
    info("interrupt: stopping active query");
    state.markInterrupt();
    await state.stop();
    // Clear stopRequested immediately so the new message can proceed.
    // The catch in runQueryStreaming suppresses the resulting AbortError
    // via signal.aborted rather than the stopRequested flag, so there is
    // no race between clearing here and the catch firing later.
    state.clearStopRequested();
  }

  return strippedText;
}
