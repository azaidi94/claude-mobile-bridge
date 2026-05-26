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
  threadId?: number,
): Promise<void> {
  // Normalize to absolute path to prevent traversal
  const resolvedPath = resolve(filePath);

  // Security: validate path is within allowed directories
  if (!isPathAllowed(resolvedPath)) {
    warn(`send_file blocked: ${resolvedPath}`);
    await busReply(ctx, `⚠️ Cannot send file outside allowed directories.`, {
      threadId,
    });
    return;
  }

  const filename = basename(resolvedPath);

  // Verify the file is readable and within Telegram's 50MB limit before
  // handing it to the bus. The bus re-reads from disk to build the upload.
  try {
    const file = Bun.file(resolvedPath);

    if (!(await file.exists())) {
      await busReply(ctx, `⚠️ Could not read file: ${filename}`, { threadId });
      return;
    }

    const size = file.size;

    if (size === 0) {
      await busReply(ctx, `⚠️ File is empty: ${filename}`, { threadId });
      return;
    }
    if (size > TELEGRAM_FILE_SIZE_LIMIT) {
      const sizeMB = (size / (1024 * 1024)).toFixed(1);
      await busReply(
        ctx,
        `⚠️ File too large (${sizeMB} MB). Telegram limit is 50 MB.`,
        { threadId },
      );
      return;
    }
  } catch {
    await busReply(ctx, `⚠️ Could not read file: ${filename}`, { threadId });
    return;
  }

  const ext = extname(filename).toLowerCase();
  const isPhoto = PHOTO_EXTENSIONS.has(ext);

  info(`send_file: ${filename} (${isPhoto ? "photo" : "document"})`);

  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const bus = getMessageBus();

  if (isPhoto) {
    const photoRes = await bus.send({
      chatId,
      threadId,
      content: filename,
      format: "plain",
      attachment: { kind: "photo", path: resolvedPath },
    });
    if ("dropped" in photoRes) {
      // Fall back to document if photo send fails (e.g. too large for photo API)
      debug(`photo fallback to document: ${filename}`);
      await bus.send({
        chatId,
        threadId,
        content: filename,
        format: "plain",
        attachment: { kind: "document", path: resolvedPath },
      });
    }
  } else {
    await bus.send({
      chatId,
      threadId,
      content: filename,
      format: "plain",
      attachment: { kind: "document", path: resolvedPath },
    });
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
    // Long plan - send as file. TODO(phase-2 attachments-from-buffer):
    // bus.send's attachment kind takes a `path` on disk; in-memory buffers
    // need a different shape.
    const buffer = Buffer.from(content, "utf-8");
    await ctx.replyWithDocument(new InputFile(buffer, "plan.md"), {
      caption: "📋 Plan ready for review",
    });
  } else {
    // Short plan - send inline with markdown formatting.
    const html = convertMarkdownToHtml(content);
    await busReply(ctx, `📋 <b>Plan:</b>\n\n${html}`, { format: "html" });
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
  // TODO(phase-2 keyboards): bus doesn't yet carry inline_keyboard.
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
        // TODO(phase-2 keyboards): bus doesn't yet carry inline_keyboard.
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
 *
 * TODO(phase-2 streaming): all sends here pass `disable_notification` and
 * store the returned grammy Message for later edit/delete via `ctx.api`.
 * Migrating to the bus needs (a) `disable_notification` on OutboundMessage,
 * and (b) a messageId-returning send + delete path. Deferred until the
 * status-message lifecycle is refactored.
 */
export function createStatusCallback(
  ctx: Context,
  state: StreamingState,
  threadId?: number,
): StatusCallback {
  return async (statusType: string, content: string, segmentId?: number) => {
    try {
      // SSE fan-out for web clients used to fire here keyed by the global
      // active session's id. After task 7g there is no global active pointer;
      // web SSE for runQueryStreaming is wired explicitly via
      // globalEventBus.makeStatusCallback in web/routes/sessions.ts. The
      // Telegram SDK path no longer cross-emits to SSE.
      if (statusType === "thinking") {
        // Show thinking inline, compact (first 500 chars)
        const preview =
          content.length > 500 ? content.slice(0, 500) + "..." : content;
        const escaped = escapeHtml(preview);
        const thinkingMsg = await ctx.reply(`🧠 <i>${escaped}</i>`, {
          parse_mode: "HTML",
          message_thread_id: threadId,
          disable_notification: true,
        });
        state.toolMessages.push(thinkingMsg);
      } else if (statusType === "tool") {
        const toolMsg = await ctx.reply(content, {
          parse_mode: "HTML",
          message_thread_id: threadId,
          disable_notification: true,
        });
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
            const msg = await ctx.reply(formatted, {
              parse_mode: "HTML",
              message_thread_id: threadId,
              disable_notification: true,
            });
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, formatted);
          } catch (htmlError) {
            // HTML parse failed, fall back to plain text
            debug(`html reply fallback: ${htmlError}`);
            const msg = await ctx.reply(formatted, {
              message_thread_id: threadId,
              disable_notification: true,
            });
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
                await ctx.reply(chunk, {
                  parse_mode: "HTML",
                  message_thread_id: threadId,
                  disable_notification: true,
                });
              } catch (htmlError) {
                debug(`chunk html fallback: ${htmlError}`);
                await ctx.reply(chunk, {
                  message_thread_id: threadId,
                  disable_notification: true,
                });
              }
            }
          }
        }
      } else if (statusType === "send_file") {
        // Send a file to the user via Telegram
        try {
          await sendFileToTelegram(ctx, content, threadId);
        } catch (err) {
          warn(`send_file error: ${err}`);
          await busReply(ctx, `⚠️ Failed to send file.`, { threadId });
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
