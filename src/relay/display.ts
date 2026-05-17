/**
 * Relay display pipeline — wires relay tool callbacks (reply/edit/react)
 * to Telegram API calls. Live progress is handled by the shared
 * handleTailEvent from watch.ts.
 */

import { InputFile } from "grammy";
import type { Api } from "grammy";
import type {
  RelayClient,
  RelayReply,
  RelayEditMessage,
  RelayReact,
} from "./client";
import type { TailDisplayState } from "../handlers/watch";
import { convertMarkdownToHtml } from "../formatting";
import { convertMarkdownToPdf } from "../lib/convert-pdf";
import { TELEGRAM_SAFE_LIMIT } from "../config";
import { debug, info, warn } from "../logger";

export interface RelayDisplayState extends TailDisplayState {
  progressMessages: import("grammy/types").Message[];
  finalReplyReceived: boolean;
  threadId?: number;
}

export function createRelayDisplayState(
  chatId: number,
  threadId?: number,
): RelayDisplayState {
  return {
    chatId,
    currentToolMsg: null,
    currentTextMsg: null,
    currentTextContent: "",
    lastTextUpdate: 0,
    segmentDone: true,
    progressMessages: [],
    finalReplyReceived: false,
    threadId,
  };
}

export function cleanupProgressMessages(
  botApi: Api,
  state: RelayDisplayState,
): void {
  for (const msg of state.progressMessages) {
    botApi.deleteMessage(state.chatId, msg.message_id).catch(() => {});
  }
  state.progressMessages = [];
  state.currentToolMsg = null;
  state.currentTextMsg = null;
  state.currentTextContent = "";
  state.segmentDone = true;
}

/**
 * Wire relay client callbacks (reply/edit/react) to Telegram.
 * Returns a cleanup function.
 */
export function wireRelayDisplay(
  botApi: Api,
  client: RelayClient,
  state: RelayDisplayState,
): () => void {
  const scopeChatId = String(state.chatId);
  const tid = state.threadId;

  const onReply = (msg: RelayReply) => {
    const alreadyHandled = state.finalReplyReceived;
    state.finalReplyReceived = true;
    const chatId = Number(msg.chat_id) || state.chatId;

    cleanupProgressMessages(botApi, state);

    if (!alreadyHandled) {
      if (msg.send_as_pdf) {
        sendPdfReply(botApi, chatId, msg.text, msg.pdf_filename, tid);
      } else {
        sendTextReply(botApi, chatId, msg.text, tid);
      }
    }

    if (msg.files?.length) {
      for (const filePath of msg.files) {
        sendFile(botApi, chatId, filePath, tid).catch((err) =>
          warn(`relay sendFile dispatch: ${err}`),
        );
      }
    }
  };

  const onEdit = (msg: RelayEditMessage) => {
    const chatId = Number(msg.chat_id) || state.chatId;
    const messageId = Number(msg.message_id);
    if (!messageId) return;

    const formatted = convertMarkdownToHtml(msg.text);
    botApi
      .editMessageText(chatId, messageId, formatted, { parse_mode: "HTML" })
      .catch((err) => debug(`relay edit: ${err}`));
  };

  const onReact = (msg: RelayReact) => {
    const chatId = Number(msg.chat_id) || state.chatId;
    const messageId = Number(msg.message_id);
    if (!messageId || !msg.emoji) return;

    botApi
      .setMessageReaction(chatId, messageId, [
        { type: "emoji", emoji: msg.emoji as any },
      ])
      .catch((err) => debug(`relay react: ${err}`));
  };

  client.onReply(onReply, scopeChatId);
  client.onEditMessage(onEdit, scopeChatId);
  client.onReact(onReact, scopeChatId);

  return () => {
    client.offReply(onReply);
    client.offEditMessage(onEdit);
    client.offReact(onReact);
  };
}

/** Convert markdown to PDF and send as document; falls back to text on failure. */
export async function sendPdfReply(
  botApi: Api,
  chatId: number,
  text: string,
  filename?: string,
  threadId?: number,
): Promise<boolean> {
  const pdfName =
    sanitizePdfFilename(filename) || deriveFilenameFromMarkdown(text);

  try {
    const buf = await convertMarkdownToPdf(text);
    const input = new InputFile(buf, pdfName);
    try {
      const msg = await botApi.sendDocument(chatId, input, {
        message_thread_id: threadId,
      });
      info("relay sendPdfReply ok", {
        chatId,
        threadId,
        messageId: msg.message_id,
        textLen: text.length,
      });
      return true;
    } catch (err) {
      warn(`pdf send: ${err}`);
      return false;
    }
  } catch (err) {
    warn(`pdf convert: ${err}`);
    return sendTextReply(botApi, chatId, text, threadId);
  }
}

function sanitizePdfFilename(name?: string): string | null {
  if (!name) return null;
  let clean = name.replace(/[/\\<>:"|?*]/g, "_").trim();
  if (!clean) return null;
  if (!clean.endsWith(".pdf")) clean += ".pdf";
  return clean;
}

function deriveFilenameFromMarkdown(text: string): string {
  const match = text.match(/^#{1,3}\s+(.+)/m);
  if (match) {
    const slug = match[1]!
      .trim()
      .replace(/[/\\<>:"|?*]/g, "_")
      .slice(0, 60);
    if (slug) return `${slug}.pdf`;
  }
  return "response.pdf";
}

async function sendHtmlWithPlainFallback(
  botApi: Api,
  chatId: number,
  html: string,
  plain: string,
  threadId: number | undefined,
  label: string,
): Promise<boolean> {
  // Returns true iff Telegram acknowledged the send. Callers (notably the
  // watch.ts onReply hook) gate `suppressRelayReplyText` on this so the
  // JSONL-tailer fallback can rescue us when the TCP fast-path fails silently
  // — previously the suppress flag was set unconditionally before the send
  // resolved, locking out the fallback even when the message never reached TG.
  try {
    const msg = await botApi.sendMessage(chatId, html, {
      parse_mode: "HTML",
      message_thread_id: threadId,
    });
    info(`relay sendTextReply ${label}(HTML) ok`, {
      chatId,
      threadId,
      messageId: msg.message_id,
      textLen: plain.length,
    });
    return true;
  } catch (err) {
    warn(`relay sendTextReply ${label}(HTML) failed: ${err}`, {
      chatId,
      threadId,
    });
    try {
      const msg = await botApi.sendMessage(chatId, plain, {
        message_thread_id: threadId,
      });
      info(`relay sendTextReply ${label}(plain) ok`, {
        chatId,
        threadId,
        messageId: msg.message_id,
        textLen: plain.length,
      });
      return true;
    } catch (err2) {
      warn(`relay sendTextReply ${label}(plain) failed: ${err2}`, {
        chatId,
        threadId,
      });
      return false;
    }
  }
}

export async function sendTextReply(
  botApi: Api,
  chatId: number,
  text: string,
  threadId?: number,
): Promise<boolean> {
  if (!text || !text.trim()) {
    warn("relay: sendTextReply called with empty text", { chatId, threadId });
    return false;
  }
  const formatted = convertMarkdownToHtml(text);
  if (formatted.length <= TELEGRAM_SAFE_LIMIT) {
    return sendHtmlWithPlainFallback(
      botApi,
      chatId,
      formatted,
      text,
      threadId,
      "",
    );
  }
  // Chunked send: succeed iff every chunk succeeded. Send in parallel because
  // chunk ordering at TG is determined by API arrival order; serializing would
  // make the user wait N× the latency for a long message.
  const results = await Promise.all(
    splitMessage(text).map((chunk) =>
      sendHtmlWithPlainFallback(
        botApi,
        chatId,
        convertMarkdownToHtml(chunk),
        chunk,
        threadId,
        "chunk ",
      ),
    ),
  );
  return results.every(Boolean);
}

function splitMessage(text: string, limit = TELEGRAM_SAFE_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const para = rest.lastIndexOf("\n\n", limit);
    const line = rest.lastIndexOf("\n", limit);
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

const PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export async function sendFile(
  botApi: Api,
  chatId: number,
  filePath: string,
  threadId?: number,
): Promise<void> {
  const ext = "." + (filePath.toLowerCase().split(".").pop() || "");
  const name = filePath.split("/").pop() || "file";

  try {
    const buf = Buffer.from(await Bun.file(filePath).arrayBuffer());
    const input = new InputFile(buf, name);

    if (PHOTO_EXTS.has(ext)) {
      await botApi.sendPhoto(chatId, input, { message_thread_id: threadId });
    } else {
      await botApi.sendDocument(chatId, input, { message_thread_id: threadId });
    }
  } catch (err) {
    warn(`relay file ${name}: ${err}`);
  }
}
