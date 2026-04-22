import { createReadStream } from "fs";
import { createInterface } from "readline";
import { findSessionJsonl } from "../tasks/reader";
import type { SseEvent } from "../sse";
import { formatToolStatus } from "../../formatting";
import { warn } from "../../logger";

interface JsonlEntry {
  type?: string;
  message?: {
    role?: "user" | "assistant";
    content?: string | unknown[];
  };
}

interface AssistantBlock {
  type: "text" | "thinking" | "tool_use";
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
}

function getClaudeDir(): string {
  return process.env.CLAUDE_DIR || `${process.env.HOME}/.claude`;
}

function mapUserEntry(entry: JsonlEntry): SseEvent[] {
  const content = entry.message?.content;
  if (typeof content === "string") {
    return content.trim() ? [{ type: "text", content: `› ${content}` }] : [];
  }
  if (!Array.isArray(content)) return [];
  const events: SseEvent[] = [];
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block.type === "text" && typeof block.text === "string") {
      events.push({ type: "text", content: `› ${block.text}` });
    }
    // tool_result intentionally skipped
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
      events.push({
        type: "tool",
        content: formatToolStatus(raw.name, input),
      });
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
