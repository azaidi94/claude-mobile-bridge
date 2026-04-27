/**
 * Session tailer - watches a JSONL session file for new events.
 *
 * Tails from a given offset, parsing new lines as they're appended.
 * Uses fs.watch for instant detection + polling as backup.
 */

import { watch, type FSWatcher } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { formatToolStatus } from "../formatting";
import { debug, warn } from "../logger";
import type { TokenUsage } from "../types";
import { PROJECTS_DIR } from "./watcher";

const POLL_INTERVAL_MS = 2_000;
const DEBOUNCE_MS = 200;
const CHANNEL_RELAY_TAG = '<channel source="channel-relay"';

/** Channel-relay wrapper attribute extractor. */
function extractOriginChatFromTag(text: string): string | undefined {
  const m = text.match(/<channel\s[^>]*\bchat_id="([^"]+)"/);
  return m ? m[1] : undefined;
}

/** Strip the `<channel …>…</channel>` wrapper, leaving inner text. */
function stripChannelTag(text: string): string {
  return text
    .replace(/^<channel\s[^>]*>\n?/, "")
    .replace(/\n?<\/channel>\s*$/, "")
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

export type TailEventType =
  | "user"
  | "text"
  | "tool"
  | "thinking"
  | "turn_boundary"
  | "turn_end"
  | "relay_reply"
  | "tool_result"
  | "permission_mode"
  | "hook_summary"
  | "usage";

export interface TailEvent {
  type: TailEventType;
  content: string;
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

  private trackRelayToolUse(id: string | undefined): void {
    if (!id) return;
    this.relayToolUseIds.add(id);
    if (this.relayToolUseIds.size > this.relayToolUseIdsMax) {
      const oldest = this.relayToolUseIds.values().next().value;
      if (oldest !== undefined) this.relayToolUseIds.delete(oldest);
    }
  }

  /**
   * Start tailing the file. If the file doesn't exist yet (e.g. claude hasn't
   * written its first message), poll until it appears, then tail from offset 0.
   * If it does exist, start from EOF so we only see new events.
   */
  async start(): Promise<void> {
    try {
      const s = await stat(this.filePath);
      this.offset = s.size;
    } catch {
      this.offset = 0;
    }

    this.tryWatchFile();

    // Polling also picks up the file once it's created.
    this.pollTimer = setInterval(() => {
      if (this.stopped) return;
      if (!this.watcher) this.tryWatchFile();
      this.readNew();
    }, POLL_INTERVAL_MS);

    debug(`tailer: started at offset ${this.offset}`);
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
        warn(`tailer: fs.watch failed: ${err}`);
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
   * Read new bytes from the file and parse lines.
   */
  private async readNew(): Promise<void> {
    if (this.stopped) return;

    try {
      const file = Bun.file(this.filePath);
      const size = file.size;
      if (size <= this.offset) return;

      const slice = file.slice(this.offset, size);
      const text = await slice.text();
      this.offset = size;

      const lines = text.split("\n").filter(Boolean);
      for (const line of lines) {
        const events = this.parseLine(line);
        for (const event of events) {
          try {
            this.callback(event);
          } catch (err) {
            warn(`tailer: callback error: ${err}`);
          }
        }
      }
    } catch (err) {
      debug(`tailer: read error: ${err}`);
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
            return resultEvents;
          }
        }

        const text = this.extractUserText(entry.message?.content);
        if (!text) return [];

        // Channel-relay-wrapped message. Emit turn_boundary (display-reset marker
        // consumed by Telegram's watch.ts) AND a `user` event with the stripped
        // text, tagged with originChat so each surface can dedup against its own
        // TCP fast-path delivery.
        if (text.includes(CHANNEL_RELAY_TAG)) {
          const originChat = extractOriginChatFromTag(text);
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

        return [{ type: "user", content: text }];
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
        for (const block of content) {
          if (block.type === "thinking" && block.thinking) {
            const preview =
              block.thinking.length > 200
                ? block.thinking.slice(0, 200) + "..."
                : block.thinking;
            events.push({ type: "thinking", content: preview });
          }

          if (block.type === "tool_use") {
            const input = (block.input as Record<string, unknown>) || {};
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
                events.push({ type: "relay_reply", content: text, originChat });
              }
              continue;
            }
            if (block.name === "mcp__channel-relay__react") {
              this.trackRelayToolUse(block.id);
              continue;
            }

            const toolDisplay = formatToolStatus(block.name, input);
            events.push({
              type: "tool",
              content: toolDisplay,
              toolName: block.name,
              toolInput: input,
              toolUseId: block.id,
            });
          }

          if (block.type === "text" && block.text) {
            events.push({ type: "text", content: block.text });
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

/** Claude encodes the project dir by replacing `/` and `.` in the cwd with `-`. */
function projectDir(cwd: string): string {
  return join(PROJECTS_DIR, cwd.replace(/[/.]/g, "-"));
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
 * Find the session ID with the most recently modified JSONL file for a project.
 * Used to detect session changes when the port file has a stale session ID
 * (e.g. after /clear on desktop — the MCP server isn't restarted so the port
 * file keeps the old ID).
 */
export async function findNewestSessionInDir(
  cwd: string,
  excludeIds?: ReadonlySet<string> | Set<string>,
): Promise<string | null> {
  const dir = projectDir(cwd);

  try {
    const files = await readdir(dir);
    let newest: { id: string; mtime: number } | null = null;

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const id = file.slice(0, -6);
      if (excludeIds?.has(id)) continue;
      const s = await stat(join(dir, file)).catch(() => null);
      if (!s) continue;
      if (!newest || s.mtimeMs > newest.mtime) {
        newest = { id, mtime: s.mtimeMs };
      }
    }

    return newest?.id ?? null;
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
