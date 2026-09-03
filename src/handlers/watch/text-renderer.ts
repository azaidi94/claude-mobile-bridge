/**
 * Text-bubble accretion: incremental edits while Claude streams text,
 * a final "settle" edit when the segment ends, and the per-segment
 * reset that clears in-flight text/tool refs. Also handles the
 * relay_reply fan-out (foreign vs own-origin, suppress-relay-reply gate).
 */

import type { Api } from "grammy";
import { STREAMING_THROTTLE_MS, TELEGRAM_SAFE_LIMIT } from "../../config";
import { convertMarkdownToHtml } from "../../formatting";
import { debug, error } from "../../logger";
import { getMessageBus } from "../../messaging";
import type { TailEvent } from "../../sessions/tailer";
import { busStubMessage, type TailDisplayState } from "./state";
import { checkAndConsumeClaim, turnClaimKey } from "./turn-claims";

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

  if (!state.currentTextMsg && !state.textMsgPending) {
    // Guard: set synchronously before the async send so a second renderText
    // call arriving before the send resolves sees the flag and falls through
    // to the edit branch (or skips) instead of opening a second bubble.
    state.textMsgPending = true;
    // Snapshot of what this send covers — renders that arrive while the send
    // is in flight hit neither branch below, so on resolve we compare and
    // catch up with an edit if content accumulated in the meantime.
    const sentSource = state.currentTextContent;
    bus
      .send({
        chatId,
        threadId,
        content: rawDisplay,
        format: "auto",
        silent: true,
        // Drop a second tailer's copy of this segment's opening bubble. Keyed
        // on the first text block of the segment; both tailers open from the
        // same block id, so only one bubble is created and it accretes edits.
        // Caveat: a segment spanning multiple text blocks (text→thinking→text)
        // only fully dedups its first block — a losing tailer can reopen on a
        // later block's id. Reduces, doesn't eliminate, two-tailer text dup;
        // the real cure is one tailer per topic.
        dedupKey: event.eventId,
      })
      .then((r) => {
        state.textMsgPending = false;
        if (!("messageId" in r)) {
          debug("tail text create dropped", {
            dropped: r.dropped,
            chatId,
            topic: threadId,
          });
          return;
        }
        const stub = busStubMessage(chatId, r.messageId);
        trackProgress(stub);
        if (state.segmentDone) {
          // Segment was reset while the send was in flight — don't resurrect
          // the stale bubble into the next segment.
          return;
        }
        state.currentTextMsg = stub;
        if (state.currentTextContent !== sentSource) {
          const catchUp =
            state.currentTextContent.length > TELEGRAM_SAFE_LIMIT
              ? state.currentTextContent.slice(0, TELEGRAM_SAFE_LIMIT) + "..."
              : state.currentTextContent;
          bus
            .edit(stub.message_id, {
              chatId,
              threadId,
              content: catchUp,
              format: "auto",
            })
            .then((r2) => {
              if (!r2.ok)
                debug("tail text catch-up edit not ok", {
                  reason: r2.reason,
                  chatId,
                  topic: threadId,
                });
            })
            .catch((err) =>
              debug("tail text catch-up edit", {
                err: String(err),
                chatId,
                topic: threadId,
              }),
            );
        }
      })
      .catch((err) => {
        state.textMsgPending = false;
        debug("tail text create", {
          err: String(err),
          chatId,
          topic: threadId,
        });
      });
  } else if (state.currentTextMsg) {
    bus
      .edit(state.currentTextMsg.message_id, {
        chatId,
        threadId,
        content: rawDisplay,
        format: "auto",
      })
      .then((r) => {
        if (!r.ok)
          debug("tail text edit not ok", {
            reason: r.reason,
            chatId,
            topic: threadId,
          });
      })
      .catch((err) =>
        debug("tail text edit", { err: String(err), chatId, topic: threadId }),
      );
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
        dedupKey: event.eventId,
      })
      .catch(() => {});
  } else {
    // Own-origin: check if the TCP relay path already claimed this turn.
    // checkAndConsumeClaim removes the entry so the next turn with the same
    // text is not incorrectly suppressed, and so a failed-then-released
    // claim never blocks delivery.
    const claims = state.relayReplyClaims;
    if (claims && checkAndConsumeClaim(claims, turnClaimKey(event.content))) {
      // TCP path claimed it and its send is in flight (or succeeded).
      return;
    }
    // TCP didn't claim this turn (failure, race, or not wired) — tailer
    // is the fallback so the Telegram topic still sees the reply. Turn-claims
    // are per-WatchState, so a second tailer's fallback isn't caught there;
    // eventId dedup at the bus drops it.
    bus
      .send({
        chatId,
        threadId,
        content: event.content,
        format: "auto",
        dedupKey: event.eventId,
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
  state.textMsgPending = false;
  state.currentTextContent = "";
  state.segmentDone = true;
}

/**
 * Backoff between finalize attempts. Short: the lane that refused us is
 * draining at the pacer's edit rate, and this write only competes with
 * intermediate edits that the final one supersedes anyway.
 */
const FINALIZE_RETRY_DELAYS_MS = [2_000, 5_000];

/** Edit outcomes after which the final text is on screen or unreachable. */
function finalizeSettled(reason: string): boolean {
  return /message is not modified|message to edit not found|message_id_invalid/i.test(
    reason,
  );
}

/**
 * The finalize edit is the ONLY write of a segment's complete text — every
 * other edit is a throttled intermediate snapshot, superseded by the next.
 * Losing it leaves the bubble frozen mid-sentence at its last 500ms snapshot,
 * and it fires at the end of a burst, exactly when the edit lane is deepest.
 * So unlike the intermediates, it retries.
 *
 * Takes plain values, not `state`: the caller clears the segment synchronously
 * and this outlives it.
 */
export async function finalizeWithRetry(
  messageId: number,
  chatId: number,
  content: string,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    let reason: string;
    try {
      const r = await getMessageBus().edit(messageId, {
        chatId,
        content,
        format: "auto",
      });
      if (r.ok) return true;
      reason = r.reason;
    } catch (err) {
      reason = String(err);
    }
    if (finalizeSettled(reason)) return true;

    const delay = FINALIZE_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      // User-visible: the paragraph stays truncated and nothing else rewrites it.
      error("tail finalize edit failed", {
        reason,
        chatId,
        messageId,
        attempts: attempt + 1,
      });
      return false;
    }
    debug("tail finalize edit retry", {
      reason,
      chatId,
      messageId,
      attempt: attempt + 1,
      delayMs: delay,
    });
    await sleep(delay);
  }
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
    void finalizeWithRetry(
      state.currentTextMsg.message_id,
      state.chatId,
      state.currentTextContent,
    );
  }

  state.currentTextMsg = null;
  state.currentTextContent = "";
  state.segmentDone = true;
}
