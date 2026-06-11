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
import { convertMarkdownToPdf } from "../lib/convert-pdf";
import { debug, info, warn } from "../logger";
import { getMessageBus } from "../messaging";

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
  // TODO(phase-2 delete): bus doesn't own deletions yet.
  for (const msg of state.progressMessages) {
    botApi.deleteMessage(state.chatId, msg.message_id).catch(() => {});
  }
  state.progressMessages = [];
  state.currentToolMsg = null;
  state.currentTextMsg = null;
  state.textMsgPending = false;
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
        getMessageBus()
          .send({
            chatId,
            threadId: tid,
            content: msg.text,
            format: "auto",
          })
          .catch((err) => warn(`relay onReply send: ${err}`));
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

    getMessageBus()
      .edit(messageId, {
        chatId,
        threadId: tid,
        content: msg.text,
        format: "auto",
      })
      .then((r) => {
        if (!r.ok) debug(`relay edit not ok: ${r.reason}`);
      })
      .catch((err) => debug(`relay edit: ${err}`));
  };

  const onReact = (msg: RelayReact) => {
    const chatId = Number(msg.chat_id) || state.chatId;
    const messageId = Number(msg.message_id);
    if (!messageId || !msg.emoji) return;

    botApi
      .setMessageReaction(chatId, messageId, [
        // Telegram restricts emoji to a fixed allowlist (ReactionTypeEmoji["emoji"]);
        // we receive an arbitrary string from the relay and let the API reject
        // invalid values rather than narrow at the boundary.
        {
          type: "emoji",
          emoji:
            msg.emoji as import("@grammyjs/types").ReactionTypeEmoji["emoji"],
        },
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
    const res = await getMessageBus().send({
      chatId,
      threadId,
      content: text,
      format: "auto",
    });
    return "messageId" in res;
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
