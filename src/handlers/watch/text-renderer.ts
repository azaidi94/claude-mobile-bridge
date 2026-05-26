/**
 * Text-bubble accretion: incremental edits while Claude streams text,
 * a final "settle" edit when the segment ends, and the per-segment
 * reset that clears in-flight text/tool refs. Also handles the
 * relay_reply fan-out (foreign vs own-origin, suppress-relay-reply gate).
 */

import type { Api } from "grammy";
import { STREAMING_THROTTLE_MS, TELEGRAM_SAFE_LIMIT } from "../../config";
import { convertMarkdownToHtml } from "../../formatting";
import { debug } from "../../logger";
import { getMessageBus } from "../../messaging";
import type { TailEvent } from "../../sessions/tailer";
import { busStubMessage, type TailDisplayState } from "./state";

/** Render a streaming text chunk. Called for `event.type === "text"`. */
export function renderText(
  botApi: Api,
  state: TailDisplayState,
  event: TailEvent,
  threadId: number | undefined,
): void {
  const { chatId } = state;
  const bus = getMessageBus();
  const trackProgress = (msg: import("grammy/types").Message) => {
    state.progressMessages?.push(msg);
  };

  if (state.currentToolMsg) {
    // TODO(phase-2 delete): bus doesn't own deletions.
    botApi
      .deleteMessage(chatId, state.currentToolMsg.message_id)
      .catch(() => {});
    state.currentToolMsg = null;
  }

  state.currentTextContent += event.content;
  state.segmentDone = false;

  const now = Date.now();
  if (now - state.lastTextUpdate < STREAMING_THROTTLE_MS) return;
  state.lastTextUpdate = now;

  const display =
    state.currentTextContent.length > TELEGRAM_SAFE_LIMIT
      ? state.currentTextContent.slice(0, TELEGRAM_SAFE_LIMIT) + "..."
      : state.currentTextContent;
  // Bus owns markdown→HTML conversion when given format="auto" — pass the
  // raw display text so bus.edit gets the same source string and the
  // edit-while-streaming math stays consistent.
  const rawDisplay = display;

  if (!state.currentTextMsg) {
    bus
      .send({
        chatId,
        threadId,
        content: rawDisplay,
        format: "auto",
        silent: true,
      })
      .then((r) => {
        if (!("messageId" in r)) {
          debug(`tail text create dropped: ${(r as any).dropped}`);
          return;
        }
        const stub = busStubMessage(chatId, r.messageId);
        state.currentTextMsg = stub;
        trackProgress(stub);
      })
      .catch((err) => debug(`tail text create: ${err}`));
  } else {
    bus
      .edit(state.currentTextMsg.message_id, {
        chatId,
        threadId,
        content: rawDisplay,
        format: "auto",
      })
      .then((r) => {
        if (!r.ok) debug(`tail text edit not ok: ${r.reason}`);
      })
      .catch((err) => debug(`tail text edit: ${err}`));
  }
}

/**
 * Render a relay_reply event: route to foreign-origin fan-out, suppress when
 * TCP already delivered it, or send as own-origin tailer fallback.
 */
export function renderRelayReply(
  _botApi: Api,
  state: TailDisplayState,
  event: TailEvent,
  threadId: number | undefined,
): void {
  const { chatId } = state;
  const bus = getMessageBus();
  const ownChat = String(chatId);
  const isForeignOrigin =
    event.originChat !== undefined && event.originChat !== ownChat;

  if (isForeignOrigin) {
    // TCP fast path delivered to the origin surface (e.g. chat_id=web),
    // not to this Telegram chat. Fan the reply here.
    bus
      .send({
        chatId,
        threadId,
        content: event.content,
        format: "auto",
      })
      .catch(() => {});
  } else if (state.suppressRelayReplyText) {
    // Own-origin and TCP's onReply already fired. Reset the flag, don't
    // duplicate.
    state.suppressRelayReplyText = false;
  } else {
    // Own-origin but TCP didn't deliver (failure or race). Tailer is the
    // fallback so the Telegram topic still sees the reply.
    bus
      .send({
        chatId,
        threadId,
        content: event.content,
        format: "auto",
      })
      .catch(() => {});
  }
}

/** Finalize pending text, drop pending tool msg, clear per-segment state. */
export function resetDisplaySegment(
  botApi: Api,
  state: TailDisplayState,
): void {
  if (state.currentTextMsg && !state.segmentDone) {
    finalizeTextMessage(botApi, state);
  }
  if (state.currentToolMsg) {
    // TODO(phase-2 delete): bus doesn't own deletions.
    botApi
      .deleteMessage(state.chatId, state.currentToolMsg.message_id)
      .catch(() => {});
    state.currentToolMsg = null;
  }
  state.currentTextMsg = null;
  state.currentTextContent = "";
  state.segmentDone = true;
}

export function finalizeTextMessage(
  _botApi: Api,
  state: TailDisplayState,
): void {
  if (!state.currentTextMsg || !state.currentTextContent) return;

  // Bus owns markdown→HTML; pre-check the formatted length only to skip the
  // overflow case (matching prior behaviour). Bus handles chunking on send
  // but edits target a single message, so a too-long final string is just
  // skipped here — the prior segment edits already showed a truncated view.
  const formatted = convertMarkdownToHtml(state.currentTextContent);
  if (formatted.length <= TELEGRAM_SAFE_LIMIT) {
    getMessageBus()
      .edit(state.currentTextMsg.message_id, {
        chatId: state.chatId,
        content: state.currentTextContent,
        format: "auto",
      })
      .then((r) => {
        if (!r.ok) debug(`tail finalize edit not ok: ${r.reason}`);
      })
      .catch((err) => debug(`tail finalize: ${err}`));
  }

  state.currentTextMsg = null;
  state.currentTextContent = "";
  state.segmentDone = true;
}
