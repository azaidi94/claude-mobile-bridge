/**
 * Session tailer - watches a JSONL session file for new events.
 *
 * Tails from a given offset, parsing new lines as they're appended.
 * Uses fs.watch for instant detection + polling as backup.
 */

import { watch, type FSWatcher } from "fs";
import { readdir, readFile, stat, open } from "fs/promises";
import { join } from "path";
import { formatToolStatus } from "../formatting";
import { debug, warn } from "../logger";
import type { AskUserQuestionItem, TokenUsage } from "../types";
import { PROJECTS_DIR } from "./watcher";
import { encodeClaudeProjectDir } from "../paths";

const POLL_INTERVAL_MS = 2_000;
const ASK_USER_QUESTION_TOOL = "AskUserQuestion";
const DEBOUNCE_MS = 200;
const CHANNEL_RELAY_TAG = '<channel source="channel-relay"';

/** Channel-relay wrapper attribute extractor. */
function extractOriginChatFromTag(text: string): string | undefined {
  const m = text.match(/<channel\s[^>]*\bchat_id="([^"]+)"/);
  return m ? m[1] : undefined;
}

/**
 * Pull the `image_path="…"` attribute the relay stamps on a `<channel …>` tag
 * when the inbound Telegram message carried a photo. The user already sees that
 * photo in the topic, so when Claude `Read`s the path to look at it we suppress
 * the Read's tool_result image (see `relayImagePaths` in SessionTailer).
 */
function extractImagePathFromTag(text: string): string | undefined {
  const m = text.match(/<channel\s[^>]*\bimage_path="([^"]+)"/);
  return m ? m[1] : undefined;
}

/** Strip the `<channel …>…</channel>` wrapper, leaving inner text. */
function stripChannelTag(text: string): string {
  return text
    .replace(/^<channel\s[^>]*>\n?/, "")
    .replace(/\n?<\/channel>\s*$/, "")
    .trim();
}

/**
 * Strip Claude Code's image-paste annotations from user text:
 *   - "[Image: source: /tmp/clipboard-….png]" — local-path noise (a TG image
 *     surfaces the picture itself, so the path is meaningless there)
 *   - "[Image #3]" — the inline paste marker
 * Returns the human-meaningful remainder (often the image's caption text).
 */
export function stripImageAnnotations(text: string): string {
  return text
    .replace(/\[Image:\s*source:[^\]]*\]/g, "")
    .replace(/\[Image\s*#\d+\]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Flatten a tool_result content (string or text-block array) into a single string. */
export function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: { type?: string; text?: string }) =>
        b?.type === "text" && typeof b.text === "string" ? b.text : "",
      )
      .filter((t) => t.length > 0)
      .join("\n");
  }
  return "";
}

/** An image to surface as a Telegram photo/document — either inline base64
 * (clipboard pastes, tool results) or a filesystem path (@-referenced uploads,
 * read at send time). */
export interface TailImage {
  mediaType?: string;
  dataBase64?: string;
  path?: string;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/**
 * Pull @-referenced image file paths out of user text, e.g.
 * `@"/Users/x/.claude/uploads/sess/IMG.png" look at this`. Claude Code stores
 * the literal @-mention in the transcript (file contents are expanded only at
 * API time), so without this the path would surface as raw text. Non-image
 * @-mentions are left untouched. Returns the paths plus the remaining text.
 */
export function extractAtImageRefs(text: string): {
  paths: string[];
  remainder: string;
} {
  const paths: string[] = [];
  const take = (_m: string, p: string): string => {
    if (IMAGE_EXT_RE.test(p)) {
      paths.push(p);
      return "";
    }
    return _m;
  };
  const remainder = text
    .replace(/@"([^"]+)"/g, take)
    .replace(/@(\S+)/g, take)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { paths, remainder };
}

/**
 * Pull base64 image blocks out of a content array. Used for both tool_result
 * content (browser screenshots, image Reads) and top-level user content
 * (desktop-pasted images). Only `source.type === "base64"` is supported —
 * url/file refs don't appear in Claude Code transcripts today.
 */
export function extractImageBlocks(content: unknown): TailImage[] {
  if (!Array.isArray(content)) return [];
  const out: TailImage[] = [];
  for (const b of content as Array<{
    type?: string;
    source?: { type?: string; media_type?: string; data?: string };
  }>) {
    if (b?.type !== "image") continue;
    const src = b.source;
    if (src?.type === "base64" && typeof src.data === "string" && src.data) {
      out.push({
        mediaType:
          typeof src.media_type === "string" ? src.media_type : "image/png",
        dataBase64: src.data,
      });
    }
  }
  return out;
}

export type TailEventType =
  | "user"
  | "text"
  | "tool"
  | "thinking"
  | "turn_boundary"
  | "turn_end"
  | "relay_reply"
  | "tool_result"
  | "image"
  | "permission_mode"
  | "hook_summary"
  | "usage"
  | "ask_user_question";

export interface TailEvent {
  type: TailEventType;
  content: string;
  /**
   * Stable per-block identity: `${entry.uuid}:${blockIndex}`. Every tailer
   * reading the same JSONL line produces the same value, so render-path sends
   * can pass it as the bus `dedupKey` — two racing/leaked tailers on one topic
   * then post each block once instead of 2×/3×. Undefined for events whose
   * source entry has no uuid (defensive; standard CC transcripts always do).
   */
  eventId?: string;
  /**
   * Surface-of-origin for channel-relay-routed events.
   * - "web" for web UI sends
   * - A Telegram chat id as string (e.g. "-1003968796171") for Telegram sends
   * - undefined for native-to-session events
   */
  originChat?: string;
  /** For "tool" events: the raw MCP tool name (e.g. "Read", "Bash"). */
  toolName?: string;
  /** For "tool" events: the raw tool input object as recorded in the JSONL. */
  toolInput?: Record<string, unknown>;
  /** For "tool_result" events: pairs the result with its tool_use block. */
  toolUseId?: string;
  /** For "tool_result" events: true when the tool reported failure. */
  isError?: boolean;
  /** For "image" events: decoded image payload to surface as a TG photo/document. */
  image?: TailImage;
  /** For "permission_mode" events: the new permission mode value. */
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  /** For "hook_summary" events: parsed details of the stop-hook run. */
  hook?: {
    hookCount: number;
    errorCount: number;
    preventedContinuation: boolean;
    firstError?: string;
    failingHookName?: string;
  };
  /** For "usage" events: parsed assistant-turn token counts. */
  usage?: TokenUsage;
  /** For "ask_user_question" events: the questions Claude is asking. */
  questions?: AskUserQuestionItem[];
}

export type TailCallback = (event: TailEvent) => void;

/**
 * Tails a JSONL session file and emits parsed events.
 */
export class SessionTailer {
  private filePath: string;
  private offset: number;
  private callback: TailCallback;
  private watcher: FSWatcher | null = null;
  private pollTimer: Timer | null = null;
  private debounceTimer: Timer | null = null;
  private stopped = false;
  /** Prevents overlapping readNew() calls from replaying the same byte range. */
  private readInFlight = false;
  /** True when a second read was requested while one was already in flight. */
  private readPending = false;
  /**
   * Tool_use ids of channel-relay tool calls (reply / edit_message / react).
   * Their assistant-side blocks are silenced (emitted as `relay_reply` or
   * dropped), so the matching tool_result must also be silenced — otherwise
   * the watch's liveness handler treats it as activity and re-arms typing
   * after `turn_end`. Bounded via FIFO eviction; a tool_result almost always
   * lands within the next entry, so we only need a short tail.
   */
  private relayToolUseIds = new Set<string>();
  private readonly relayToolUseIdsMax = 64;
  /**
   * Filesystem paths of photos the user sent in via Telegram (the relay stamps
   * them as `image_path="…"` on the `<channel>` tag). The user already sees
   * these in the topic, so when Claude `Read`s one to look at it we must NOT
   * echo the Read's tool_result image back. Bounded FIFO — a Read almost always
   * lands within the next few entries.
   */
  private relayImagePaths = new Set<string>();
  private readonly relayImagePathsMax = 32;
  /**
   * Tool_use ids of `Read`s of a `relayImagePaths` file — their tool_result
   * image block is dropped so the user's own photo isn't surfaced twice. The
   * tool_result itself still emits (Read remains a visible tool action).
   * Bounded FIFO; consumed when its tool_result lands.
   */
  private suppressImageToolUseIds = new Set<string>();
  private readonly suppressImageToolUseIdsMax = 64;
  /**
   * Last permission mode emitted as an event. Claude's runtime appends a
   * permission-mode sentinel after every turn even when the mode hasn't
   * changed; emitting that as an event re-arms the watch's liveness typing
   * after turn_end. Dedup at the tailer so all consumers see only real
   * mode changes.
   */
  private lastEmittedPermissionMode: string | undefined;

  constructor(filePath: string, callback: TailCallback) {
    this.filePath = filePath;
    this.offset = 0;
    this.callback = callback;
  }

  /**
   * Pre-seek to start tailing from the beginning of the file rather than EOF.
   * Used when the watch's drift detector swaps to a freshly-created JSONL —
   * the new file is, by definition, all-new content for the new conversation,
   * and the user's first prompt may already be on disk before this tailer's
   * start() runs. Without this, EOF positioning skips it.
   *
   * Must be called before start(). No-op once start() has run.
   */
  startFromBeginning(): void {
    this.offset = 0;
    this.startAtOffsetZero = true;
  }
  private startAtOffsetZero = false;

  private trackRelayToolUse(id: string | undefined): void {
    if (!id) return;
    this.relayToolUseIds.add(id);
    if (this.relayToolUseIds.size > this.relayToolUseIdsMax) {
      const oldest = this.relayToolUseIds.values().next().value;
      if (oldest !== undefined) this.relayToolUseIds.delete(oldest);
    }
  }

  /** Remember a Telegram-origin photo path (FIFO-bounded). */
  private trackRelayImagePath(path: string | undefined): void {
    if (!path) return;
    this.relayImagePaths.add(path);
    if (this.relayImagePaths.size > this.relayImagePathsMax) {
      const oldest = this.relayImagePaths.values().next().value;
      if (oldest !== undefined) this.relayImagePaths.delete(oldest);
    }
  }

  /** Flag a tool_use whose image tool_result should be dropped (FIFO-bounded). */
  private markSuppressImageToolUse(id: string | undefined): void {
    if (!id) return;
    this.suppressImageToolUseIds.add(id);
    if (this.suppressImageToolUseIds.size > this.suppressImageToolUseIdsMax) {
      const oldest = this.suppressImageToolUseIds.values().next().value;
      if (oldest !== undefined) this.suppressImageToolUseIds.delete(oldest);
    }
  }

  /**
   * Start tailing the file. If the file doesn't exist yet (e.g. claude hasn't
   * written its first message), poll until it appears, then tail from offset 0.
   * If it does exist, start from EOF so we only see new events — UNLESS the
   * caller invoked startFromBeginning() (drift-detected new conversation),
   * in which case we tail from offset 0 so the user's first prompt isn't
   * skipped.
   */
  async start(): Promise<void> {
    if (this.startAtOffsetZero) {
      this.offset = 0;
    } else {
      try {
        const s = await stat(this.filePath);
        this.offset = s.size;
      } catch {
        this.offset = 0;
      }
    }

    this.tryWatchFile();

    // Polling also picks up the file once it's created.
    this.pollTimer = setInterval(() => {
      if (this.stopped) return;
      if (!this.watcher) this.tryWatchFile();
      this.readNew();
    }, POLL_INTERVAL_MS);

    // Drift-restart path: drain immediately so the user's first prompt isn't
    // delayed by up to POLL_INTERVAL_MS waiting for the next poll tick.
    if (this.startAtOffsetZero && this.offset === 0) {
      void this.readNew();
    }

    debug("tailer: started", { offset: this.offset });
  }

  /**
   * Set up fs.watch on the file. No-op if already watching, stopped, or the
   * file doesn't exist yet — pollTimer will retry.
   */
  private tryWatchFile(): void {
    if (this.watcher || this.stopped) return;
    try {
      this.watcher = watch(this.filePath, (event) => {
        if (this.stopped) return;
        if (event === "change") {
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => this.readNew(), DEBOUNCE_MS);
        }
      });
    } catch (err) {
      // ENOENT is expected — file may not exist yet, polling will retry.
      // Warn on anything else (EMFILE, EACCES, etc.) so real failures surface.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        warn("tailer: fs.watch failed", err);
      }
    }
  }

  /**
   * Stop tailing and clean up.
   */
  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    debug("tailer: stopped");
  }

  /**
   * Schedule a read if not already in flight. Concurrent callers (poll timer
   * + fs.watch debounce) coalesce: at most one extra read queues while
   * another is running, preventing the same byte range from being replayed.
   */
  private readNew(): void {
    if (this.stopped) return;
    if (this.readInFlight) {
      this.readPending = true;
      return;
    }
    this.readInFlight = true;
    void this.doRead();
  }

  /**
   * Read new bytes from the file and parse lines.
   *
   * Torn-write safety: only advance the offset past the last `\n`-terminated
   * line. If the writer is mid-append the trailing fragment stays unconsumed
   * and will be picked up on the next read, so no entry is permanently lost.
   *
   * Stopped safety: checks `this.stopped` after each await and before each
   * callback delivery, so `stop()` is effective even for in-flight reads.
   */
  private async doRead(): Promise<void> {
    try {
      if (this.stopped) return;

      const file = Bun.file(this.filePath);
      const size = file.size;

      // Truncation / in-place rewrite recovery. If the file shrank below our
      // saved offset (e.g. Claude Code compacted and rewrote the JSONL), the
      // old `size <= offset` guard would bail forever — the tailer went
      // silently dead for that session while fs.watch/poll kept firing. Resync
      // to the new EOF so subsequent appends are read again. We jump to EOF
      // (rather than re-reading from 0) to avoid replaying the whole rewritten
      // file into the surfaces.
      if (size < this.offset) {
        warn("tailer: file shrank, resyncing to EOF", undefined, {
          from: this.offset,
          to: size,
          file: this.filePath,
        });
        this.offset = size;
        return;
      }
      if (size === this.offset) return;

      const readStart = this.offset;
      const slice = file.slice(readStart, size);
      const text = await slice.text();

      if (this.stopped) return;

      // Only consume up to the last complete (newline-terminated) line.
      // Bytes after the last `\n` are a partial write; leave them unconsumed
      // so the next read will retry from the same position.
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline === -1) return;

      const consumed = text.slice(0, lastNewline + 1);
      // Offsets are byte offsets; text.length is UTF-16 code units. Use
      // Buffer.byteLength to account for multi-byte UTF-8 characters.
      this.offset = readStart + Buffer.byteLength(consumed, "utf-8");

      const lines = consumed.split("\n").filter(Boolean);
      for (const line of lines) {
        if (this.stopped) return;
        const events = this.parseLine(line);
        for (const event of events) {
          if (this.stopped) return;
          try {
            this.callback(event);
          } catch (err) {
            warn("tailer: callback error", err);
          }
        }
      }
    } catch (err) {
      debug("tailer: read error", { err: String(err) });
    } finally {
      this.readInFlight = false;
      if (this.readPending && !this.stopped) {
        this.readPending = false;
        this.readNew();
      }
    }
  }

  /**
   * Parse a JSONL line into TailEvents. Returns all relevant blocks
   * from a single entry (e.g. thinking + tool_use in the same turn).
   */
  parseLine(line: string): TailEvent[] {
    try {
      const entry = JSON.parse(line);

      // Skip sidechain messages
      if (entry.isSidechain) return [];

      // User message from desktop (skip channel-relay injected messages)
      if (entry.type === "user") {
        // Tool_result content blocks must be emitted before extractUserText runs,
        // since tool_result-only content yields no text and would be dropped.
        const rawContent = entry.message?.content;
        // Relay-wrapped user messages originate from a Telegram send — their
        // top-level images are already visible in the topic, so don't echo
        // them back. (tool_result images are unaffected; relay tools never
        // produce images.)
        const isRelayWrapped =
          Array.isArray(rawContent) &&
          rawContent.some(
            (b: { type?: string; text?: string }) =>
              b?.type === "text" &&
              typeof b.text === "string" &&
              b.text.includes(CHANNEL_RELAY_TAG),
          );
        const pastedImageEvents: TailEvent[] = isRelayWrapped
          ? []
          : extractImageBlocks(rawContent).map((img) => ({
              type: "image" as const,
              content: "",
              image: img,
            }));
        if (Array.isArray(rawContent)) {
          const resultEvents: TailEvent[] = [];
          for (const block of rawContent as Array<{
            type?: string;
            tool_use_id?: string;
            content?: unknown;
            is_error?: boolean;
          }>) {
            if (block.type !== "tool_result") continue;
            const toolUseId = String(block.tool_use_id ?? "");
            if (!toolUseId) continue;
            // Channel-relay tool_use blocks are silenced upstream (reply/edit
            // → relay_reply, react → dropped). Their tool_result must be
            // silenced too, or the watch's liveness handler re-arms typing
            // after the turn_end that fires on the same assistant message.
            if (this.relayToolUseIds.has(toolUseId)) {
              this.relayToolUseIds.delete(toolUseId);
              continue;
            }
            // Image blocks first, so renderImage can still resolve the tool
            // name from toolUseRegistry before renderToolResult frees it.
            // Skip when this Read fetched a photo the user just sent in via
            // Telegram — `delete` both tests membership and consumes the flag.
            if (!this.suppressImageToolUseIds.delete(toolUseId)) {
              for (const img of extractImageBlocks(block.content)) {
                resultEvents.push({
                  type: "image",
                  content: "",
                  toolUseId,
                  image: img,
                });
              }
            }
            resultEvents.push({
              type: "tool_result",
              content: extractToolResultText(block.content),
              toolUseId,
              isError: Boolean(block.is_error),
            });
          }
          if (resultEvents.length > 0) {
            const onlyToolResults = (
              rawContent as Array<{ type?: string }>
            ).every((b) => b.type === "tool_result");
            if (onlyToolResults) return resultEvents;
            // Mixed: append any user-text events too
            const text = this.extractUserText(rawContent);
            if (text) {
              if (text.includes(CHANNEL_RELAY_TAG)) {
                const originChat = extractOriginChatFromTag(text);
                this.trackRelayImagePath(extractImagePathFromTag(text));
                const inner = stripChannelTag(text);
                resultEvents.push({ type: "turn_boundary", content: "" });
                if (inner) {
                  resultEvents.push({
                    type: "user",
                    content: inner,
                    originChat,
                  });
                }
              } else {
                resultEvents.push({ type: "user", content: text });
              }
            }
            return [...pastedImageEvents, ...resultEvents];
          }
        }

        const text = this.extractUserText(entry.message?.content);
        if (!text) return pastedImageEvents;

        // Native (non-relay) terminal image input. Two shapes:
        //  1. @-referenced uploads → text like `@"/…/IMG.png" caption`; surface
        //     the file and fold the remaining text as the caption.
        //  2. Clipboard paste → typed text + an image block, plus a SEPARATE
        //     standalone "[Image: source: /tmp/…]" annotation entry; fold the
        //     typed text into the caption and drop the annotation-only entry.
        if (!text.includes(CHANNEL_RELAY_TAG)) {
          const at = extractAtImageRefs(text);
          if (at.paths.length > 0) {
            const refImages: TailEvent[] = at.paths.map((path, idx) => ({
              type: "image",
              content: idx === 0 ? at.remainder : "",
              image: { path },
            }));
            return [...pastedImageEvents, ...refImages];
          }
          const cleaned = stripImageAnnotations(text);
          if (pastedImageEvents.length > 0) {
            if (cleaned) pastedImageEvents[0]!.content = cleaned;
            return pastedImageEvents;
          }
          if (!cleaned) return []; // entry was pure image-source annotation
        }

        // Channel-relay-wrapped message. Emit turn_boundary (display-reset marker
        // consumed by Telegram's watch.ts) AND a `user` event with the stripped
        // text, tagged with originChat so each surface can dedup against its own
        // TCP fast-path delivery.
        if (text.includes(CHANNEL_RELAY_TAG)) {
          const originChat = extractOriginChatFromTag(text);
          this.trackRelayImagePath(extractImagePathFromTag(text));
          const inner = stripChannelTag(text);
          const events: TailEvent[] = [{ type: "turn_boundary", content: "" }];
          if (inner) {
            events.push({ type: "user", content: inner, originChat });
          }
          return events;
        }

        // Local command output (e.g. /model, /cost) — strip tags and ANSI codes
        const cmdMatch = text.match(
          /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/,
        );
        if (cmdMatch) {
          const cmdOutput = cmdMatch[1]!
            // Strip ANSI escape codes
            .replace(/\x1b\[[0-9;]*m/g, "")
            .trim();
          // Skip trivial/empty output
          if (!cmdOutput) return [];
          return [{ type: "user", content: `⌘ ${cmdOutput}` }];
        }

        return [...pastedImageEvents, { type: "user", content: text }];
      }

      // Background-task completion ping. Claude Code persists these as
      // attachment entries (queued for injection at the next turn), not as
      // user-message JSONL entries — so without this branch they'd be
      // invisible to the bridge.
      if (
        entry.type === "attachment" &&
        entry.attachment?.type === "queued_command" &&
        entry.attachment?.commandMode === "task-notification"
      ) {
        const prompt = String(entry.attachment.prompt ?? "");
        if (!prompt) return [];
        return [{ type: "user", content: prompt }];
      }

      if (entry.type === "permission-mode") {
        const mode = entry.permissionMode;
        if (typeof mode !== "string") return [];
        if (this.lastEmittedPermissionMode === mode) return [];
        this.lastEmittedPermissionMode = mode;
        return [
          {
            type: "permission_mode",
            content: mode,
            permissionMode: mode as TailEvent["permissionMode"],
          },
        ];
      }

      if (entry.type === "system" && entry.subtype === "stop_hook_summary") {
        const hookCount = Number(entry.hookCount) || 0;
        const errorCount = Array.isArray(entry.hookErrors)
          ? entry.hookErrors.length
          : 0;
        const preventedContinuation = Boolean(entry.preventedContinuation);
        if (errorCount === 0 && !preventedContinuation) return [];
        const firstError =
          errorCount > 0
            ? String(entry.hookErrors[0]?.error ?? entry.hookErrors[0] ?? "")
            : undefined;
        const failingHookName =
          errorCount > 0 ? String(entry.hookErrors[0]?.name ?? "") : undefined;
        return [
          {
            type: "hook_summary",
            content: firstError ?? `${hookCount} hook(s) ran`,
            hook: {
              hookCount,
              errorCount,
              preventedContinuation,
              firstError,
              failingHookName,
            },
          },
        ];
      }

      // Assistant message — emit all blocks.
      // Handles two JSONL formats:
      //   1. {type:"assistant", message:{content:[]}}  — standard format
      //   2. {message:{type:"message", role:"assistant", content:[]}}  — message-format (no top-level type)
      if (
        entry.type === "assistant" ||
        (!entry.type && entry.message?.role === "assistant")
      ) {
        const content = entry.message?.content;
        if (!Array.isArray(content)) return [];

        const events: TailEvent[] = [];
        // `${uuid}:${idx}` is stable across every tailer that reads this line,
        // so render-path sends can dedup a duplicated stream (leaked tailers).
        const entryUuid =
          typeof entry.uuid === "string" ? entry.uuid : undefined;
        for (let idx = 0; idx < content.length; idx++) {
          const block = content[idx];
          const eventId = entryUuid ? `${entryUuid}:${idx}` : undefined;
          if (block.type === "thinking" && block.thinking) {
            const preview =
              block.thinking.length > 200
                ? block.thinking.slice(0, 200) + "..."
                : block.thinking;
            events.push({ type: "thinking", content: preview, eventId });
          }

          if (block.type === "tool_use") {
            const input = (block.input as Record<string, unknown>) || {};
            // Render-only: card surfaces context; answering happens at desktop.
            if (block.name === ASK_USER_QUESTION_TOOL) {
              const questions =
                (input.questions as AskUserQuestionItem[] | undefined) ?? [];
              events.push({
                type: "ask_user_question",
                content: "",
                questions,
                toolUseId: block.id,
                eventId,
              });
              continue;
            }
            // Detect channel-relay reply/edit/react → emit as relay_reply.
            // TCP path owns Telegram delivery; never render these as tool-progress.
            if (
              block.name === "mcp__channel-relay__reply" ||
              block.name === "mcp__channel-relay__edit_message"
            ) {
              this.trackRelayToolUse(block.id);
              const text = String(input.text || "");
              const originChat =
                typeof input.chat_id === "string" ? input.chat_id : undefined;
              if (text) {
                events.push({
                  type: "relay_reply",
                  content: text,
                  originChat,
                  eventId,
                });
              }
              continue;
            }
            if (block.name === "mcp__channel-relay__react") {
              this.trackRelayToolUse(block.id);
              continue;
            }

            // A Read of a Telegram-origin photo (the user's own inbound image)
            // returns the picture as a tool_result image block — drop it so the
            // photo isn't echoed back into the topic. The Read tool action still
            // renders; only its image result is suppressed (matched below by id).
            const filePath =
              typeof input.file_path === "string" ? input.file_path : undefined;
            if (filePath && this.relayImagePaths.has(filePath)) {
              this.markSuppressImageToolUse(block.id);
            }

            const toolDisplay = formatToolStatus(block.name, input);
            events.push({
              type: "tool",
              content: toolDisplay,
              toolName: block.name,
              toolInput: input,
              toolUseId: block.id,
              eventId,
            });
          }

          if (block.type === "text" && block.text) {
            events.push({ type: "text", content: block.text, eventId });
          }
        }

        const usage = entry.message?.usage;
        if (
          typeof usage?.input_tokens === "number" &&
          typeof usage?.output_tokens === "number"
        ) {
          events.push({
            type: "usage",
            content: "",
            usage: {
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cache_creation_input_tokens: usage.cache_creation_input_tokens,
              cache_read_input_tokens: usage.cache_read_input_tokens,
            },
          });
        }

        // turn_end: assistant message with zero `tool` events marks end of
        // turn. Channel-relay tool_use blocks emit `relay_reply` (or nothing
        // for react) instead of `tool`, so they don't suppress turn_end —
        // once the relay reply lands the user has the answer; if Claude
        // continues internally, the next event will re-arm typing.
        const hasToolUse = events.some((e) => e.type === "tool");
        if (!hasToolUse && events.length > 0) {
          events.push({ type: "turn_end", content: "" });
        }

        return events;
      }
    } catch {
      // Malformed JSON line
    }
    return [];
  }

  /**
   * Extract text from user message content.
   */
  private extractUserText(content: unknown): string | null {
    if (typeof content === "string") return content.trim() || null;
    if (!Array.isArray(content)) return null;
    // Skip tool_result-only messages
    if (content.every((b: { type?: string }) => b.type === "tool_result"))
      return null;
    const texts = content
      .filter((b: { type?: string }) => b.type === "text")
      .map((b: { text?: string }) => b.text || "")
      .filter(Boolean);
    return texts.join(" ").trim() || null;
  }
}

/**
 * Encode a cwd into the directory-name segment Claude Code uses under
 * ~/.claude/projects/. Delegates to the single shared encoder in paths.ts —
 * Claude replaces EVERY non-alphanumeric char (incl. `_`), not just `/` and `.`.
 */
export function encodeProjectPath(cwd: string): string {
  return encodeClaudeProjectDir(cwd);
}

/** Claude encodes the project dir by replacing `/` and `.` in the cwd with `-`. */
function projectDir(cwd: string): string {
  return join(PROJECTS_DIR, encodeProjectPath(cwd));
}

/**
 * Find the JSONL file path for a session ID.
 */
export async function findSessionJsonlPath(
  sessionId: string,
): Promise<string | null> {
  const filename = `${sessionId}.jsonl`;

  try {
    const projects = await readdir(PROJECTS_DIR);
    for (const project of projects) {
      if (project.startsWith(".")) continue;
      const filePath = join(PROJECTS_DIR, project, filename);
      const s = await stat(filePath).catch(() => null);
      if (s?.isFile()) return filePath;
    }
  } catch {
    // PROJECTS_DIR doesn't exist
  }
  return null;
}

/**
 * True when a JSONL file is a real conversation transcript rather than one of
 * the metadata-only sidecar files Claude Code drops into the same project dir
 * (e.g. `{ai-title}` / `{agent-name}` stubs it writes for session naming).
 * A genuine transcript always carries at least one conversation turn
 * (`user`/`assistant`/`system`) or a line bearing the session's `cwd`; a
 * title/name stub carries neither. Reads only the file head — the qualifying
 * lines appear within the first few KB, and the stubs are tiny anyway.
 *
 * Used to keep drift detection from rebinding a watch onto a stub whose mtime
 * momentarily makes it the "newest" file — which otherwise spams the topic
 * with "🔄 started a new conversation" every time the stub is touched.
 * Exported as a test seam.
 */
export async function isSessionTranscript(jsonlPath: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(jsonlPath, "r");
    const { buffer, bytesRead } = await fh.read({
      buffer: Buffer.alloc(65536),
      position: 0,
    });
    const content = buffer.toString("utf8", 0, bytesRead);
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(line);
      } catch {
        // A truncated final line (head cut mid-record) — skip it.
        continue;
      }
      if (typeof data.cwd === "string" && data.cwd.length > 0) return true;
      if (
        data.type === "user" ||
        data.type === "assistant" ||
        data.type === "system"
      ) {
        return true;
      }
    }
    return false;
  } catch {
    // Unreadable/missing: treat as non-transcript so we don't drift onto it.
    return false;
  } finally {
    await fh?.close();
  }
}

/**
 * Find the session ID with the most recently modified JSONL file for a project.
 * Used to detect session changes when the port file has a stale session ID
 * (e.g. after /clear on desktop — the MCP server isn't restarted so the port
 * file keeps the old ID).
 *
 * Candidates are considered newest-first and validated as real transcripts:
 * Claude Code writes metadata-only title/name stubs into the same dir, and a
 * freshly-touched stub must not be mistaken for a new conversation.
 */
export async function findNewestSessionInDir(
  cwd: string,
  excludeIds?: ReadonlySet<string> | Set<string>,
): Promise<string | null> {
  const dir = projectDir(cwd);

  try {
    const files = await readdir(dir);
    const candidates: { id: string; mtime: number; path: string }[] = [];

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const id = file.slice(0, -6);
      if (excludeIds?.has(id)) continue;
      const path = join(dir, file);
      const s = await stat(path).catch(() => null);
      if (!s) continue;
      candidates.push({ id, mtime: s.mtimeMs, path });
    }

    candidates.sort((a, b) => b.mtime - a.mtime);
    for (const c of candidates) {
      if (await isSessionTranscript(c.path)) return c.id;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Compute the expected JSONL path for a session that may not yet exist on disk.
 * Used to start a tailer before claude has written its first message — the
 * tailer waits for the file to appear via polling + delayed fs.watch.
 */
export function getExpectedJsonlPath(cwd: string, sessionId: string): string {
  return join(projectDir(cwd), `${sessionId}.jsonl`);
}

/**
 * Read the last meaningful message from a JSONL session file.
 * Returns the last assistant text or user prompt, truncated for display.
 */
export async function getLastSessionMessage(
  jsonlPath: string,
  maxLen = 300,
): Promise<{ role: "user" | "assistant"; text: string } | null> {
  try {
    const raw = await readFile(jsonlPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);

    let lastUser: string | null = null;
    let lastAssistant: string | null = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "user") {
          const content = entry.message?.content;
          const text =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .filter((b: { type: string }) => b.type === "text")
                    .map((b: { text: string }) => b.text)
                    .join("")
                : null;
          if (
            text &&
            !text.includes(CHANNEL_RELAY_TAG) &&
            !text.includes("<local-command-stdout>")
          ) {
            lastUser = text.trim();
          }
        } else if (
          entry.type === "assistant" ||
          (!entry.type && entry.message?.role === "assistant")
        ) {
          const content = entry.message?.content;
          if (Array.isArray(content)) {
            const text = content
              .filter((b: { type: string }) => b.type === "text")
              .map((b: { text: string }) => b.text)
              .join("");
            if (text.trim()) lastAssistant = text.trim();
          }
        }
      } catch {
        // skip malformed lines
      }
    }

    // Prefer the last assistant message, fall back to last user prompt
    const text = lastAssistant ?? lastUser;
    const role = lastAssistant ? "assistant" : "user";
    if (!text) return null;
    return {
      role,
      text: text.length > maxLen ? text.slice(0, maxLen) + "…" : text,
    };
  } catch {
    return null;
  }
}
