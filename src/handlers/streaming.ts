/**
 * Shared streaming callback for Claude Telegram Bot handlers.
 *
 * Provides a reusable status callback for streaming Claude responses.
 */

import { basename, extname, resolve } from "path";
import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { InlineKeyboard, InputFile } from "grammy";
import type {
  StatusCallback,
  AskUserQuestionInput,
  AskUserQuestionItem,
  AskUserQuestionState,
} from "../types";
import { convertMarkdownToHtml, escapeHtml } from "../formatting";
import {
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_SAFE_LIMIT,
  STREAMING_THROTTLE_MS,
  BUTTON_LABEL_MAX_LENGTH,
} from "../config";
import { isPathAllowed } from "../security";
import { debug, warn, error, info } from "../logger";

/**
 * Image extensions that Telegram Bot API accepts via sendPhoto.
 * GIF is excluded: Telegram converts GIFs to MPEG-4, losing the original.
 * BMP is excluded: not supported by Telegram's photo API.
 */
const PHOTO_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** Max file size Telegram accepts (50 MB). */
const TELEGRAM_FILE_SIZE_LIMIT = 50 * 1024 * 1024;

/**
 * Send a file to the user via Telegram.
 * Photos (.jpg, .png, .webp) are sent natively; everything else as a document.
 */
export async function sendFileToTelegram(
  ctx: Context,
  filePath: string,
): Promise<void> {
  // Normalize to absolute path to prevent traversal
  const resolvedPath = resolve(filePath);

  // Security: validate path is within allowed directories
  if (!isPathAllowed(resolvedPath)) {
    warn(`send_file blocked: ${resolvedPath}`);
    await ctx.reply(`⚠️ Cannot send file outside allowed directories.`);
    return;
  }

  const filename = basename(resolvedPath);

  // Read file atomically via Bun.file() — avoids TOCTOU race
  let fileBuffer: Buffer;
  try {
    const file = Bun.file(resolvedPath);

    if (!(await file.exists())) {
      await ctx.reply(`⚠️ Could not read file: ${filename}`);
      return;
    }

    const size = file.size;

    if (size === 0) {
      await ctx.reply(`⚠️ File is empty: ${filename}`);
      return;
    }
    if (size > TELEGRAM_FILE_SIZE_LIMIT) {
      const sizeMB = (size / (1024 * 1024)).toFixed(1);
      await ctx.reply(
        `⚠️ File too large (${sizeMB} MB). Telegram limit is 50 MB.`,
      );
      return;
    }

    fileBuffer = Buffer.from(await file.arrayBuffer());
  } catch {
    await ctx.reply(`⚠️ Could not read file: ${filename}`);
    return;
  }

  const ext = extname(filename).toLowerCase();
  const isPhoto = PHOTO_EXTENSIONS.has(ext);
  const inputFile = new InputFile(fileBuffer, filename);

  info(`send_file: ${filename} (${isPhoto ? "photo" : "document"})`);

  if (isPhoto) {
    try {
      await ctx.replyWithPhoto(inputFile, { caption: filename });
    } catch {
      // Fall back to document if photo send fails (e.g. too large for photo API)
      debug(`photo fallback to document: ${filename}`);
      const fallbackFile = new InputFile(fileBuffer, filename);
      await ctx.replyWithDocument(fallbackFile, { caption: filename });
    }
  } else {
    await ctx.replyWithDocument(inputFile, { caption: filename });
  }
}

// State maps for AskUserQuestion
export const pendingAskUserQuestions = new Map<string, AskUserQuestionState>();
export const pendingAskUserQuestionCustom = new Map<number, string>(); // chatId -> requestId

/**
 * Create inline keyboard for ask_user options.
 */
export function createAskUserKeyboard(
  requestId: string,
  options: string[],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let idx = 0; idx < options.length; idx++) {
    const option = options[idx]!;
    // Truncate long options for button display
    const display =
      option.length > BUTTON_LABEL_MAX_LENGTH
        ? option.slice(0, BUTTON_LABEL_MAX_LENGTH) + "..."
        : option;
    const callbackData = `askuser:${requestId}:${idx}`;
    keyboard.text(display, callbackData).row();
  }
  return keyboard;
}

/**
 * Create inline keyboard for plan approval.
 */
export function createPlanApprovalKeyboard(requestId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Accept", `plan:accept:${requestId}`)
    .row()
    .text("❌ Reject", `plan:reject:${requestId}`)
    .row()
    .text("✏️ Edit", `plan:edit:${requestId}`);
}

/**
 * Send plan content to Telegram - file for long plans, inline for short.
 */
export async function sendPlanContent(
  ctx: Context,
  content: string,
): Promise<void> {
  if (content.length > 4000) {
    // Long plan - send as file
    const buffer = Buffer.from(content, "utf-8");
    await ctx.replyWithDocument(new InputFile(buffer, "plan.md"), {
      caption: "📋 Plan ready for review",
    });
  } else {
    // Short plan - send inline with markdown formatting
    const html = convertMarkdownToHtml(content);
    await ctx.reply(`📋 <b>Plan:</b>\n\n${html}`, { parse_mode: "HTML" });
  }
}

/**
 * Truncate label for button display.
 */
function truncateLabel(
  label: string,
  maxLength: number = BUTTON_LABEL_MAX_LENGTH,
): string {
  return label.length > maxLength ? label.slice(0, maxLength) + "..." : label;
}

/**
 * Create inline keyboard for AskUserQuestion.
 */
export function createAskUserQuestionKeyboard(
  question: AskUserQuestionItem,
  requestId: string,
  questionIndex: number,
  totalQuestions: number,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Add option buttons
  question.options.forEach((opt, i) => {
    keyboard.text(truncateLabel(opt.label), `auq:${requestId}:opt:${i}`).row();
  });

  // Add "Custom" button
  keyboard.text("✏️ Custom", `auq:${requestId}:custom`).row();

  // Add "Skip All" button
  if (totalQuestions > 1 || questionIndex === 0) {
    keyboard.text("⏭️ Skip & Proceed", `auq:${requestId}:skip`);
  }

  return keyboard;
}

/**
 * Check for pending AskUserQuestion requests and send inline keyboards.
 */
export async function checkPendingAskUserQuestionRequests(
  ctx: Context,
  chatId: number,
  input: AskUserQuestionInput,
  toolUseId: string,
  isPlanMode: boolean = false,
): Promise<boolean> {
  if (!input.questions || input.questions.length === 0) {
    return false;
  }

  const requestId = `${Date.now()}`;
  const question = input.questions[0]!;

  // Store pending state (preserve plan mode for when user answers)
  pendingAskUserQuestions.set(requestId, {
    toolUseId,
    questions: input.questions,
    currentIndex: 0,
    answers: [],
    chatId,
    isPlanMode,
  });

  // Build question text with header if present
  let questionText = `❓ ${question.question}`;
  if (question.header) {
    questionText = `<b>${escapeHtml(question.header)}</b>\n\n${questionText}`;
  }

  // Add descriptions if present
  if (question.options.some((o) => o.description)) {
    questionText += "\n";
    question.options.forEach((opt, i) => {
      if (opt.description) {
        questionText += `\n<b>${i + 1}. ${escapeHtml(opt.label)}</b>: ${escapeHtml(opt.description)}`;
      }
    });
  }

  const keyboard = createAskUserQuestionKeyboard(
    question,
    requestId,
    0,
    input.questions.length,
  );
  await ctx.reply(questionText, { reply_markup: keyboard, parse_mode: "HTML" });

  return true;
}

/**
 * Check for pending ask-user requests and send inline keyboards.
 */
export async function checkPendingAskUserRequests(
  ctx: Context,
  chatId: number,
): Promise<boolean> {
  const glob = new Bun.Glob("ask-user-*.json");
  let buttonsSent = false;

  for await (const filename of glob.scan({ cwd: "/tmp", absolute: false })) {
    const filepath = `/tmp/${filename}`;
    try {
      const file = Bun.file(filepath);
      const text = await file.text();
      const data = JSON.parse(text);

      // Only process pending requests for this chat
      if (data.status !== "pending") continue;
      if (String(data.chat_id) !== String(chatId)) continue;

      const question = data.question || "Please choose:";
      const options = data.options || [];
      const requestId = data.request_id || "";

      if (options.length > 0 && requestId) {
        const keyboard = createAskUserKeyboard(requestId, options);
        await ctx.reply(`❓ ${question}`, { reply_markup: keyboard });
        buttonsSent = true;

        // Mark as sent
        data.status = "sent";
        await Bun.write(filepath, JSON.stringify(data));
      }
    } catch (err) {
      warn(`ask-user file: ${err}`);
    }
  }

  return buttonsSent;
}

/**
 * Tracks state for streaming message updates.
 */
export class StreamingState {
  textMessages = new Map<number, Message>(); // segment_id -> telegram message
  toolMessages: Message[] = []; // ephemeral tool status messages
  lastEditTimes = new Map<number, number>(); // segment_id -> last edit time
  lastContent = new Map<number, string>(); // segment_id -> last sent content
}

/**
 * Create a status callback for streaming updates.
 */
export function createStatusCallback(
  ctx: Context,
  state: StreamingState,
): StatusCallback {
  return async (statusType: string, content: string, segmentId?: number) => {
    try {
      if (statusType === "thinking") {
        // Show thinking inline, compact (first 500 chars)
        const preview =
          content.length > 500 ? content.slice(0, 500) + "..." : content;
        const escaped = escapeHtml(preview);
        const thinkingMsg = await ctx.reply(`🧠 <i>${escaped}</i>`, {
          parse_mode: "HTML",
        });
        state.toolMessages.push(thinkingMsg);
      } else if (statusType === "tool") {
        const toolMsg = await ctx.reply(content, { parse_mode: "HTML" });
        state.toolMessages.push(toolMsg);
      } else if (statusType === "text" && segmentId !== undefined) {
        if (!content) return; // Skip empty text segments (e.g. file-only responses)
        const now = Date.now();
        const lastEdit = state.lastEditTimes.get(segmentId) || 0;

        if (!state.textMessages.has(segmentId)) {
          // New segment - create message
          const display =
            content.length > TELEGRAM_SAFE_LIMIT
              ? content.slice(0, TELEGRAM_SAFE_LIMIT) + "..."
              : content;
          const formatted = convertMarkdownToHtml(display);
          try {
            const msg = await ctx.reply(formatted, { parse_mode: "HTML" });
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, formatted);
          } catch (htmlError) {
            // HTML parse failed, fall back to plain text
            debug(`html reply fallback: ${htmlError}`);
            const msg = await ctx.reply(formatted);
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, formatted);
          }
          state.lastEditTimes.set(segmentId, now);
        } else if (now - lastEdit > STREAMING_THROTTLE_MS) {
          // Update existing segment message (throttled)
          const msg = state.textMessages.get(segmentId)!;
          const display =
            content.length > TELEGRAM_SAFE_LIMIT
              ? content.slice(0, TELEGRAM_SAFE_LIMIT) + "..."
              : content;
          const formatted = convertMarkdownToHtml(display);
          // Skip if content unchanged
          if (formatted === state.lastContent.get(segmentId)) {
            return;
          }
          try {
            await ctx.api.editMessageText(
              msg.chat.id,
              msg.message_id,
              formatted,
              {
                parse_mode: "HTML",
              },
            );
            state.lastContent.set(segmentId, formatted);
          } catch (htmlError) {
            debug(`html edit fallback: ${htmlError}`);
            try {
              await ctx.api.editMessageText(
                msg.chat.id,
                msg.message_id,
                formatted,
              );
              state.lastContent.set(segmentId, formatted);
            } catch (editError) {
              debug(`edit failed: ${editError}`);
            }
          }
          state.lastEditTimes.set(segmentId, now);
        }
      } else if (statusType === "segment_end" && segmentId !== undefined) {
        if (state.textMessages.has(segmentId) && content) {
          const msg = state.textMessages.get(segmentId)!;
          const formatted = convertMarkdownToHtml(content);

          // Skip if content unchanged
          if (formatted === state.lastContent.get(segmentId)) {
            return;
          }

          if (formatted.length <= TELEGRAM_MESSAGE_LIMIT) {
            try {
              await ctx.api.editMessageText(
                msg.chat.id,
                msg.message_id,
                formatted,
                {
                  parse_mode: "HTML",
                },
              );
            } catch (err) {
              debug(`final edit: ${err}`);
            }
          } else {
            // Too long - delete and split
            try {
              await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
            } catch (err) {
              debug(`delete for split: ${err}`);
            }
            for (let i = 0; i < formatted.length; i += TELEGRAM_SAFE_LIMIT) {
              const chunk = formatted.slice(i, i + TELEGRAM_SAFE_LIMIT);
              try {
                await ctx.reply(chunk, { parse_mode: "HTML" });
              } catch (htmlError) {
                debug(`chunk html fallback: ${htmlError}`);
                await ctx.reply(chunk);
              }
            }
          }
        }
      } else if (statusType === "send_file") {
        // Send a file to the user via Telegram
        try {
          await sendFileToTelegram(ctx, content);
        } catch (err) {
          warn(`send_file error: ${err}`);
          await ctx.reply(`⚠️ Failed to send file.`);
        }
      } else if (statusType === "done") {
        // Delete tool messages - text messages stay
        for (const toolMsg of state.toolMessages) {
          try {
            await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
          } catch (err) {
            debug(`delete tool msg: ${err}`);
          }
        }
      }
    } catch (err) {
      error(`callback: ${err}`);
    }
  };
}
