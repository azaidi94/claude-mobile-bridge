/**
 * Parse conversation history from Claude Code session JSONL files.
 */

import { readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { escapeHtml } from "../formatting";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const CHUNK_SIZE = 128 * 1024; // 128KB
const USER_MSG_LENGTH = 150;
const ASSISTANT_MSG_LENGTH = 80;
const LAST_ASSISTANT_MSG_LENGTH = 400;

interface ParsedTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ConversationPair {
  user: string;
  assistant: string | null;
}

/**
 * Find the JSONL file for a session UUID.
 */
async function findJsonlPath(sessionId: string): Promise<string | null> {
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
    // PROJECTS_DIR doesn't exist or not readable
  }
  return null;
}

/**
 * Join all text blocks from a content array.
 */
function extractTextBlocks(
  content: Array<{ type?: string; text?: string }>,
): string | null {
  const texts = content
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .filter(Boolean);

  return texts.join(" ").trim() || null;
}

/**
 * Extract text from user message content.
 * Returns null if content is empty or only tool_result blocks.
 */
function extractUserText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  if (content.every((b: { type?: string }) => b.type === "tool_result"))
    return null;
  return extractTextBlocks(content);
}

/**
 * Extract text from assistant message content.
 * Returns null if only tool_use/thinking blocks.
 */
function extractAssistantText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  return extractTextBlocks(content);
}

/**
 * Parse a JSONL line into a turn, or null if not relevant.
 */
function parseLine(line: string): ParsedTurn | null {
  try {
    const entry = JSON.parse(line);

    if (entry.isSidechain) return null;

    if (entry.type === "user") {
      const text = extractUserText(entry.message?.content);
      if (!text) return null;
      return { role: "user", text };
    }

    if (entry.type === "assistant") {
      const text = extractAssistantText(entry.message?.content);
      if (!text) return null;
      return { role: "assistant", text };
    }
  } catch {
    // Malformed line
  }
  return null;
}

/**
 * Group turns into user→assistant pairs.
 * Each pair anchors on a real human message with the first assistant response after it.
 */
function pairTurns(turns: ParsedTurn[]): ConversationPair[] {
  const pairs: ConversationPair[] = [];
  let currentUser: string | null = null;

  for (const turn of turns) {
    if (turn.role === "user") {
      // If we had a previous user with no assistant, push it solo
      if (currentUser !== null) {
        pairs.push({ user: currentUser, assistant: null });
      }
      currentUser = turn.text;
    } else if (turn.role === "assistant" && currentUser !== null) {
      pairs.push({ user: currentUser, assistant: turn.text });
      currentUser = null;
    }
    // Skip assistant messages that don't follow a user message
  }

  // Trailing user message with no response
  if (currentUser !== null) {
    pairs.push({ user: currentUser, assistant: null });
  }

  return pairs;
}

/**
 * Get recent conversation pairs from a session JSONL file.
 */
export async function getRecentHistory(
  sessionId: string,
  maxPairs: number = 3,
): Promise<ConversationPair[]> {
  if (!sessionId) return [];

  const filePath = await findJsonlPath(sessionId);
  if (!filePath) return [];

  try {
    const file = Bun.file(filePath);
    const size = file.size;
    if (size === 0) return [];

    // Read from tail
    const start = Math.max(0, size - CHUNK_SIZE);
    const slice = file.slice(start, size);
    const text = await slice.text();

    const lines = text.split("\n").filter(Boolean);

    // Discard first line if we sliced mid-file (likely truncated)
    if (start > 0 && lines.length > 0) {
      lines.shift();
    }

    // Parse all relevant turns
    const turns: ParsedTurn[] = [];
    for (const line of lines) {
      const turn = parseLine(line);
      if (turn) turns.push(turn);
    }

    // Group into user→assistant pairs, take last N
    const pairs = pairTurns(turns);
    return pairs.slice(-maxPairs);
  } catch {
    return [];
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

/**
 * Format conversation pairs into a Telegram HTML message.
 * Wrapped in expandable blockquote. Last assistant response gets more space.
 * Drops oldest pairs if result exceeds Telegram's 4096 char limit.
 */
export function formatHistoryMessage(pairs: ConversationPair[]): string {
  if (pairs.length === 0) return "";

  // Drop oldest pairs until we fit within Telegram's limit
  let visible = pairs;
  while (visible.length > 0) {
    const result = renderPairs(visible);
    if (result.length <= 4000) return result;
    visible = visible.slice(1);
  }

  return "";
}

function renderPairs(pairs: ConversationPair[]): string {
  const lines: string[] = [];
  const lastIdx = pairs.length - 1;

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]!;
    const isLast = i === lastIdx;

    const userText = escapeHtml(truncate(pair.user, USER_MSG_LENGTH));
    lines.push(`👤 ${userText}`);

    if (pair.assistant) {
      const maxLen = isLast ? LAST_ASSISTANT_MSG_LENGTH : ASSISTANT_MSG_LENGTH;
      const assistantText = escapeHtml(truncate(pair.assistant, maxLen));
      lines.push(`🤖 ${assistantText}`);
    }
    if (!isLast) lines.push("");
  }

  const inner = lines.join("\n");
  return `💬 <b>Recent</b>\n<blockquote expandable>${inner}</blockquote>`;
}
