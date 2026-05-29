/**
 * MessageBus — single outbound path for Telegram messages.
 *
 * Phase 2 step 1: this module is purely additive. No handler / watch / cursor
 * code consumes it yet. Steps 3–5 migrate the existing sites onto the bus.
 *
 * The bus owns:
 *   - parse-mode resolution (via ./format)
 *   - chunking (via ./format)
 *   - plain fallback on TG parse errors
 *   - dedup TTL cache (60s, keyed on `dedupKey`)
 *   - per-(chatId,threadId) token-bucket rate limit (~30/min)
 *   - one log schema: `bus.send` (debug level; set DEBUG=1) with
 *     opId/chatId/threadId/kind/durationMs/result. Genuine failures
 *     (ratelimit, send/edit errors) also surface at warn.
 */

import { InputFile } from "grammy";
import type { Api } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { debug, warn, createOpId, elapsedMs } from "../logger";
import {
  resolveParseMode,
  chunkContent,
  plainFallback,
  type FormatHint,
  type ResolvedParseMode,
} from "./format";

export type AttachmentKind = "photo" | "document" | "voice";

export interface OutboundMessage {
  chatId: number;
  threadId?: number;
  content: string;
  format?: FormatHint;
  /** Idempotency key; bus drops a duplicate within DEDUP_TTL_MS. */
  dedupKey?: string;
  replyTo?: { messageId: number };
  attachment?: { kind: AttachmentKind; path: string };
  /**
   * Suppress the user's push notification for this message (TG's
   * `disable_notification`). Used by quiet streaming bubbles in watch.ts.
   */
  silent?: boolean;
  /**
   * Optional inline keyboard. Grammy's `InlineKeyboard` class is JSON-compatible
   * with `InlineKeyboardMarkup` (grammy serialises it transparently), so callers
   * may pass either an `InlineKeyboard` instance or a plain
   * `{ inline_keyboard: [[...]] }` object.
   */
  replyMarkup?: InlineKeyboardMarkup;
  /** Optional caller-provided opId for correlation; bus generates one if absent. */
  opId?: string;
}

export type DropReason = "dedup" | "ratelimit" | "error";

export type SendResult =
  | { messageId: number }
  | { dropped: DropReason; reason?: string };

export type EditResult = { ok: true } | { ok: false; reason: string };

export interface EditInput {
  chatId: number;
  threadId?: number;
  content: string;
  format?: FormatHint;
  /** Optional inline keyboard to replace on edit. */
  replyMarkup?: InlineKeyboardMarkup;
  opId?: string;
}

export interface MessageBus {
  send(msg: OutboundMessage): Promise<SendResult>;
  edit(messageId: number, msg: EditInput): Promise<EditResult>;
}

// --- Tunables -------------------------------------------------------------

const DEDUP_TTL_MS = 60_000;
const RATE_LIMIT_TOKENS = 30;
const RATE_LIMIT_REFILL_PER_SEC = 30 / 60; // 30 per minute → 0.5/s
const RATE_LIMIT_WAIT_MS = 5_000;
const RATE_LIMIT_POLL_MS = 100;

// --- Helpers --------------------------------------------------------------

interface Bucket {
  tokens: number;
  lastRefill: number; // ms epoch
}

function isParseEntityError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /can't parse entities|can not parse entities|parse_mode/i.test(msg);
}

function isMessageMissingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /message to edit not found|message_id_invalid|MESSAGE_ID_INVALID/i.test(
    msg,
  );
}

// --- Implementation -------------------------------------------------------

// --- Singleton -----------------------------------------------------------

let _instance: MessageBus | null = null;

/**
 * Install the global MessageBus instance. Called once in `src/bot.ts`
 * after the `Bot` is constructed. Tests can override by re-calling.
 */
export function setMessageBus(bus: MessageBus): void {
  _instance = bus;
}

/**
 * Get the global MessageBus instance. Throws if uninitialised — that's a
 * programmer error (the bus must be wired in `bot.ts` before any handler
 * runs).
 */
export function getMessageBus(): MessageBus {
  if (!_instance) {
    throw new Error(
      "MessageBus not initialised — call setMessageBus(createMessageBus(api)) at startup",
    );
  }
  return _instance;
}

export function createMessageBus(api: Api): MessageBus {
  // dedupKey → expiresAt (ms epoch). Cleanup is lazy.
  const dedupCache = new Map<string, number>();
  // `${chatId}:${threadId ?? ""}` → bucket.
  const buckets = new Map<string, Bucket>();

  function rateKey(chatId: number, threadId?: number): string {
    return `${chatId}:${threadId ?? ""}`;
  }

  function refillBucket(b: Bucket): void {
    const now = Date.now();
    const elapsed = (now - b.lastRefill) / 1000;
    if (elapsed <= 0) return;
    const tokens = Math.min(
      RATE_LIMIT_TOKENS,
      b.tokens + elapsed * RATE_LIMIT_REFILL_PER_SEC,
    );
    b.tokens = tokens;
    b.lastRefill = now;
  }

  function tryConsumeToken(key: string): boolean {
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: RATE_LIMIT_TOKENS, lastRefill: Date.now() };
      buckets.set(key, b);
    }
    refillBucket(b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  async function waitForToken(key: string): Promise<boolean> {
    const deadline = Date.now() + RATE_LIMIT_WAIT_MS;
    while (Date.now() < deadline) {
      if (tryConsumeToken(key)) return true;
      await Bun.sleep(RATE_LIMIT_POLL_MS);
    }
    return tryConsumeToken(key);
  }

  function cleanupDedup(): void {
    const now = Date.now();
    for (const [k, exp] of dedupCache) {
      if (exp <= now) dedupCache.delete(k);
    }
  }

  function checkDedup(key: string | undefined): boolean {
    if (!key) return false;
    cleanupDedup();
    const exp = dedupCache.get(key);
    if (exp && exp > Date.now()) return true;
    dedupCache.set(key, Date.now() + DEDUP_TTL_MS);
    return false;
  }

  /** Send one chunk of text. Returns messageId on success, throws otherwise. */
  async function sendOneText(
    chatId: number,
    threadId: number | undefined,
    chunk: string,
    parseMode: ResolvedParseMode | undefined,
    replyTo: { messageId: number } | undefined,
    rawChunk: string,
    formatHint: FormatHint,
    silent: boolean,
    replyMarkup: InlineKeyboardMarkup | undefined,
  ): Promise<number> {
    const opts: Parameters<Api["sendMessage"]>[2] = {};
    if (parseMode) opts.parse_mode = parseMode;
    if (threadId !== undefined) opts.message_thread_id = threadId;
    if (silent) opts.disable_notification = true;
    if (replyTo) {
      opts.reply_parameters = { message_id: replyTo.messageId };
    }
    if (replyMarkup) opts.reply_markup = replyMarkup;
    try {
      const msg = await api.sendMessage(chatId, chunk, opts);
      return msg.message_id;
    } catch (err) {
      if (parseMode && isParseEntityError(err)) {
        // Plain fallback.
        const plain = plainFallback(rawChunk, formatHint);
        const plainOpts: Parameters<Api["sendMessage"]>[2] = {};
        if (threadId !== undefined) plainOpts.message_thread_id = threadId;
        if (silent) plainOpts.disable_notification = true;
        if (replyTo) {
          plainOpts.reply_parameters = {
            message_id: replyTo.messageId,
          };
        }
        if (replyMarkup) plainOpts.reply_markup = replyMarkup;
        const msg = await api.sendMessage(chatId, plain, plainOpts);
        return msg.message_id;
      }
      throw err;
    }
  }

  async function sendAttachment(
    chatId: number,
    threadId: number | undefined,
    kind: AttachmentKind,
    path: string,
    caption: string | undefined,
    parseMode: ResolvedParseMode | undefined,
    rawCaption: string,
    formatHint: FormatHint,
    silent: boolean,
  ): Promise<number> {
    const buf = Buffer.from(await Bun.file(path).arrayBuffer());
    const name = path.split("/").pop() || "file";
    const input = new InputFile(buf, name);
    const baseOpts: Record<string, unknown> = {};
    if (threadId !== undefined) baseOpts.message_thread_id = threadId;
    if (silent) baseOpts.disable_notification = true;
    if (caption) {
      baseOpts.caption = caption;
      if (parseMode) baseOpts.parse_mode = parseMode;
    }
    try {
      let msg;
      if (kind === "photo") {
        msg = await api.sendPhoto(
          chatId,
          input,
          baseOpts as Parameters<Api["sendPhoto"]>[2],
        );
      } else if (kind === "document") {
        msg = await api.sendDocument(
          chatId,
          input,
          baseOpts as Parameters<Api["sendDocument"]>[2],
        );
      } else {
        msg = await api.sendVoice(
          chatId,
          input,
          baseOpts as Parameters<Api["sendVoice"]>[2],
        );
      }
      return msg.message_id;
    } catch (err) {
      if (parseMode && caption && isParseEntityError(err)) {
        const plain = plainFallback(rawCaption, formatHint);
        const plainOpts: Record<string, unknown> = { caption: plain };
        if (threadId !== undefined) plainOpts.message_thread_id = threadId;
        if (silent) plainOpts.disable_notification = true;
        // Re-create input — InputFile streams may be consumed on first send.
        const buf2 = Buffer.from(await Bun.file(path).arrayBuffer());
        const input2 = new InputFile(buf2, name);
        let msg;
        if (kind === "photo") {
          msg = await api.sendPhoto(
            chatId,
            input2,
            plainOpts as Parameters<Api["sendPhoto"]>[2],
          );
        } else if (kind === "document") {
          msg = await api.sendDocument(
            chatId,
            input2,
            plainOpts as Parameters<Api["sendDocument"]>[2],
          );
        } else {
          msg = await api.sendVoice(
            chatId,
            input2,
            plainOpts as Parameters<Api["sendVoice"]>[2],
          );
        }
        return msg.message_id;
      }
      throw err;
    }
  }

  return {
    async send(msg: OutboundMessage): Promise<SendResult> {
      const opId = msg.opId ?? createOpId("bus");
      const startedAt = Date.now();
      const kind: "text" | AttachmentKind = msg.attachment?.kind ?? "text";

      // Dedup gate.
      if (checkDedup(msg.dedupKey)) {
        debug("bus.send", {
          opId,
          chatId: msg.chatId,
          threadId: msg.threadId,
          kind,
          durationMs: elapsedMs(startedAt),
          result: "drop:dedup",
          dedupKey: msg.dedupKey,
          chunkCount: 0,
        });
        return { dropped: "dedup" };
      }

      // Rate limit.
      const rkey = rateKey(msg.chatId, msg.threadId);
      const got = await waitForToken(rkey);
      if (!got) {
        // Surfaced at warn (not just the structured info line) so a sustained
        // burst that outruns the token bucket is visible in ops — the user
        // sees a silent gap otherwise.
        warn("bus.send ratelimit drop", {
          opId,
          chatId: msg.chatId,
          threadId: msg.threadId,
          kind,
        });
        debug("bus.send", {
          opId,
          chatId: msg.chatId,
          threadId: msg.threadId,
          kind,
          durationMs: elapsedMs(startedAt),
          result: "drop:ratelimit",
          dedupKey: msg.dedupKey,
          chunkCount: 0,
        });
        return { dropped: "ratelimit" };
      }

      try {
        const formatHint: FormatHint = msg.format ?? "auto";

        if (msg.attachment) {
          const resolved = resolveParseMode(msg.content, formatHint);
          const messageId = await sendAttachment(
            msg.chatId,
            msg.threadId,
            msg.attachment.kind,
            msg.attachment.path,
            msg.content ? resolved.content : undefined,
            resolved.parse_mode,
            msg.content,
            formatHint,
            msg.silent === true,
          );
          debug("bus.send", {
            opId,
            chatId: msg.chatId,
            threadId: msg.threadId,
            kind,
            durationMs: elapsedMs(startedAt),
            result: "ok",
            dedupKey: msg.dedupKey,
            chunkCount: 1,
          });
          return { messageId };
        }

        // Text path: chunk the RAW content, then resolve parse-mode per chunk.
        // Converting each raw chunk independently (rather than chunking
        // already-converted HTML) keeps every chunk's HTML self-contained — a
        // tag can't be sliced across a chunk boundary, which TG would reject —
        // and keeps the plain-fallback source exactly aligned with what was
        // sent. Mirrors the old sendTextReply.
        const rawChunks = chunkContent(msg.content);

        let firstMessageId: number | null = null;
        for (let i = 0; i < rawChunks.length; i++) {
          const rawChunk = rawChunks[i]!;
          const resolvedChunk = resolveParseMode(rawChunk, formatHint);
          // Reply-markup only on the first chunk (TG would otherwise repeat
          // the keyboard on every chunk).
          const id = await sendOneText(
            msg.chatId,
            msg.threadId,
            resolvedChunk.content,
            resolvedChunk.parse_mode,
            i === 0 ? msg.replyTo : undefined,
            rawChunk,
            formatHint,
            msg.silent === true,
            i === 0 ? msg.replyMarkup : undefined,
          );
          if (firstMessageId === null) firstMessageId = id;
        }
        debug("bus.send", {
          opId,
          chatId: msg.chatId,
          threadId: msg.threadId,
          kind,
          durationMs: elapsedMs(startedAt),
          result: "ok",
          dedupKey: msg.dedupKey,
          chunkCount: rawChunks.length,
        });
        return { messageId: firstMessageId ?? 0 };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        warn("bus.send error", {
          opId,
          chatId: msg.chatId,
          threadId: msg.threadId,
          err: reason,
        });
        debug("bus.send", {
          opId,
          chatId: msg.chatId,
          threadId: msg.threadId,
          kind,
          durationMs: elapsedMs(startedAt),
          result: "drop:error",
          dedupKey: msg.dedupKey,
          chunkCount: 0,
        });
        return { dropped: "error", reason };
      }
    },

    async edit(messageId: number, input: EditInput): Promise<EditResult> {
      const opId = input.opId ?? createOpId("bus");
      const startedAt = Date.now();
      const formatHint: FormatHint = input.format ?? "auto";
      const resolved = resolveParseMode(input.content, formatHint);
      try {
        const opts: Parameters<Api["editMessageText"]>[3] = {};
        if (resolved.parse_mode) opts.parse_mode = resolved.parse_mode;
        if (input.replyMarkup) opts.reply_markup = input.replyMarkup;
        try {
          await api.editMessageText(
            input.chatId,
            messageId,
            resolved.content,
            opts,
          );
        } catch (err) {
          if (resolved.parse_mode && isParseEntityError(err)) {
            const plain = plainFallback(input.content, formatHint);
            const plainOpts: Parameters<Api["editMessageText"]>[3] = {};
            if (input.replyMarkup) plainOpts.reply_markup = input.replyMarkup;
            await api.editMessageText(
              input.chatId,
              messageId,
              plain,
              plainOpts,
            );
          } else {
            throw err;
          }
        }
        debug("bus.send", {
          opId,
          chatId: input.chatId,
          threadId: input.threadId,
          kind: "text",
          durationMs: elapsedMs(startedAt),
          result: "ok:edit",
          chunkCount: 1,
        });
        return { ok: true };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const tag = isMessageMissingError(err) ? "drop:missing" : "drop:error";
        // A missing target is a benign delete race; a real edit failure isn't —
        // surface it at warn (the send path already warns on its errors).
        if (tag === "drop:error") {
          warn("bus.send edit error", {
            opId,
            chatId: input.chatId,
            threadId: input.threadId,
            err: reason,
          });
        }
        debug("bus.send", {
          opId,
          chatId: input.chatId,
          threadId: input.threadId,
          kind: "text",
          durationMs: elapsedMs(startedAt),
          result: tag,
          chunkCount: 0,
        });
        return { ok: false, reason };
      }
    },
  };
}
