/**
 * Stage-aware reactions on inbound TG messages.
 *
 *   👀 received  → bot saw the message
 *   🤔 working   → CC produced its first text/tool/thinking event
 *   🎉 done      → turn_end / relay_reply fired
 *
 * Per-thread state holds the message_id we're currently tracking. New user
 * input replaces it; concurrent turns don't fight because TG only honours
 * the bot's most recent reaction per message.
 */

import type { Api } from "grammy";
import { debug } from "../logger";

type AllowedEmoji = import("@grammyjs/types").ReactionTypeEmoji["emoji"];

const RECEIVED: AllowedEmoji = "👀";
const WORKING: AllowedEmoji = "🤔";
const DONE: AllowedEmoji = "🎉";

interface PendingReaction {
  chatId: number;
  messageId: number;
  stage: "received" | "working" | "done";
}

const pending = new Map<string, PendingReaction>();

function key(chatId: number, threadId: number | undefined): string {
  return `${chatId}:${threadId ?? 0}`;
}

async function setReaction(
  api: Api,
  chatId: number,
  messageId: number,
  emoji: AllowedEmoji,
): Promise<void> {
  try {
    await api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }]);
  } catch (err) {
    debug(`reactions: setMessageReaction failed: ${err}`);
  }
}

/** Mark an inbound user message as received (👀). Replaces any prior tracker on this thread. */
export function markReceived(
  api: Api,
  chatId: number,
  threadId: number | undefined,
  messageId: number,
): void {
  pending.set(key(chatId, threadId), {
    chatId,
    messageId,
    stage: "received",
  });
  void setReaction(api, chatId, messageId, RECEIVED);
}

/** Promote the current pending message on this thread to "working" (🤔). No-op if already past received. */
export function markWorking(
  api: Api,
  chatId: number,
  threadId: number | undefined,
): void {
  const entry = pending.get(key(chatId, threadId));
  if (!entry || entry.stage !== "received") return;
  entry.stage = "working";
  void setReaction(api, entry.chatId, entry.messageId, WORKING);
}

/** Promote the current pending message on this thread to "done" (🎉) and clear the tracker. */
export function markDone(
  api: Api,
  chatId: number,
  threadId: number | undefined,
): void {
  const k = key(chatId, threadId);
  const entry = pending.get(k);
  if (!entry || entry.stage === "done") return;
  entry.stage = "done";
  pending.delete(k);
  void setReaction(api, entry.chatId, entry.messageId, DONE);
}

/** Test seam: clear all in-flight reaction state. */
export function _resetReactionsForTesting(): void {
  pending.clear();
}

/** Test seam: snapshot current pending state for a thread. */
export function _peekPendingForTesting(
  chatId: number,
  threadId: number | undefined,
): PendingReaction | undefined {
  return pending.get(key(chatId, threadId));
}
