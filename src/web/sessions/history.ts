import { createReadStream } from "fs";
import { createInterface } from "readline";
import { findSessionJsonl } from "../tasks/reader";
import type { SseEvent } from "../sse";
import { formatToolStatus } from "../../formatting";
import { warn } from "../../logger";
import { extractToolResultText } from "../../sessions/tailer";

interface JsonlEntry {
  type?: string;
  message?: {
    role?: "user" | "assistant";
    content?: string | unknown[];
  };
  subtype?: string;
  permissionMode?: unknown;
  hookCount?: number;
  hookErrors?: unknown;
  preventedContinuation?: boolean;
}

interface AssistantBlock {
  type: "text" | "thinking" | "tool_use";
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  id?: string;
}

function getClaudeDir(): string {
  return process.env.CLAUDE_DIR || `${process.env.HOME}/.claude`;
}

// Channel-relay-wrapped messages come from the web UI or Telegram
// (<channel source="channel-relay" chat_id=…>). Untagged user entries are
// native terminal-typed input in the desktop Claude TUI. Telegram renders
// the former as the user's own message and the latter prefixed "🖥 Desktop:";
// the web UI mirrors that distinction via text prefixes the Terminal
// component then groups into "user" vs "desktop" turns.
const CHANNEL_TAG_RE = /^<channel\s[^>]*>([\s\S]*?)<\/channel>\s*$/;

function classifyUserText(raw: string): SseEvent | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = trimmed.match(CHANNEL_TAG_RE);
  if (m) {
    const inner = m[1]!.trim();
    return inner ? { type: "text", content: `› ${inner}` } : null;
  }
  return { type: "text", content: `🖥 ${trimmed}` };
}

function mapUserEntry(entry: JsonlEntry): SseEvent[] {
  const content = entry.message?.content;
  if (typeof content === "string") {
    const ev = classifyUserText(content);
    return ev ? [ev] : [];
  }
  if (!Array.isArray(content)) return [];
  const events: SseEvent[] = [];
  for (const block of content as Array<{
    type?: string;
    text?: string;
    tool_use_id?: string;
    content?: unknown;
    is_error?: boolean;
  }>) {
    if (block.type === "text" && typeof block.text === "string") {
      // Only channel-relay wrapped messages are user-visible; plain text
      // blocks in content arrays are internal tool injections (e.g. skill
      // content) and should not be rendered.
      const trimmed = block.text.trim();
      if (CHANNEL_TAG_RE.test(trimmed)) {
        const ev = classifyUserText(trimmed);
        if (ev) events.push(ev);
      }
    } else if (block.type === "tool_result") {
      const toolUseId = String(block.tool_use_id ?? "");
      if (!toolUseId) continue;
      events.push({
        type: "tool_result",
        content: extractToolResultText(block.content),
        toolUseId,
        isError: Boolean(block.is_error),
      });
    }
  }
  return events;
}

function mapAssistantEntry(entry: JsonlEntry, turnIdx: number): SseEvent[] {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  const events: SseEvent[] = [];
  let textSegment = 0;
  for (const raw of content as AssistantBlock[]) {
    if (raw.type === "thinking" && raw.thinking) {
      events.push({ type: "thinking", content: raw.thinking });
    } else if (
      raw.type === "text" &&
      typeof raw.text === "string" &&
      raw.text.length > 0
    ) {
      events.push({
        type: "text",
        content: raw.text,
        segmentId: turnIdx * 100 + textSegment,
      });
      textSegment += 1;
    } else if (raw.type === "tool_use" && raw.name) {
      const input = (raw.input ?? {}) as Record<string, unknown>;

      // Channel-relay reply/edit: user-visible reply text lives in input.text,
      // not a separate text block (see src/sessions/tailer.ts).
      if (
        raw.name === "mcp__channel-relay__reply" ||
        raw.name === "mcp__channel-relay__edit_message"
      ) {
        const text = typeof input.text === "string" ? input.text : "";
        if (text) {
          events.push({
            type: "text",
            content: text,
            segmentId: turnIdx * 100 + textSegment,
          });
          textSegment += 1;
        }
      } else if (raw.name !== "mcp__channel-relay__react") {
        events.push({
          type: "tool",
          content: formatToolStatus(raw.name, input),
          toolName: raw.name,
          toolInput: input,
          toolUseId: typeof raw.id === "string" ? raw.id : undefined,
        });
      }
    }
  }
  return events;
}

export async function readSessionHistory(
  sessionId: string,
  limit: number,
): Promise<SseEvent[]> {
  const jsonl = await findSessionJsonl(getClaudeDir(), sessionId);
  if (!jsonl) return [];

  const all: SseEvent[] = [];
  let turnIdx = 0;

  const stream = createReadStream(jsonl, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: JsonlEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === "user" && entry.message?.role === "user") {
        all.push(...mapUserEntry(entry));
      } else if (
        entry.type === "assistant" &&
        entry.message?.role === "assistant"
      ) {
        all.push(...mapAssistantEntry(entry, turnIdx));
        turnIdx += 1;
      } else if (entry.type === "permission-mode") {
        const mode = entry.permissionMode;
        if (typeof mode === "string") {
          all.push({
            type: "permission_mode",
            content: mode,
            permissionMode: mode as SseEvent["permissionMode"],
          });
        }
      } else if (entry.type === "system") {
        if (entry.subtype === "stop_hook_summary") {
          const errors = Array.isArray(entry.hookErrors)
            ? (entry.hookErrors as Array<{ name?: string; error?: string }>)
            : [];
          const preventedContinuation = Boolean(entry.preventedContinuation);
          if (errors.length > 0 || preventedContinuation) {
            all.push({
              type: "hook_summary",
              content:
                errors[0]?.error ?? `${entry.hookCount ?? 0} hook(s) ran`,
              hook: {
                hookCount: entry.hookCount ?? 0,
                errorCount: errors.length,
                preventedContinuation,
                firstError: errors[0]?.error,
                failingHookName: errors[0]?.name,
              },
            });
          }
        }
      }
    }
  } catch (err) {
    warn(`history: failed reading ${jsonl}: ${(err as Error).message}`);
  } finally {
    rl.close();
    stream.close();
  }

  return all.length <= limit ? all : all.slice(all.length - limit);
}
