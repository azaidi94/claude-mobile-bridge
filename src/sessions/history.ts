/**
 * Parse conversation history from Claude Code session JSONL files.
 */

import type { Context } from "grammy";
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
 * Find the most recent JSONL file for a directory.
 * Project dirs are path-encoded: /Users/ali/Dev/foo → -Users-ali-Dev-foo
 */
async function findLatestJsonlForDir(dir: string): Promise<string | null> {
  const encoded = dir.replace(/\/+$/, "").replace(/\//g, "-");

  try {
    const projectDir = join(PROJECTS_DIR, encoded);
    const files = await readdir(projectDir);
    let best: { path: string; mtime: number } | null = null;

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(projectDir, file);
      const s = await stat(filePath).catch(() => null);
      if (s?.isFile()) {
        const mtime = s.mtime?.getTime() || 0;
        if (!best || mtime > best.mtime) {
          best = { path: filePath, mtime };
        }
      }
    }
    return best?.path || null;
  } catch {
    return null;
  }
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
 * Includes text blocks and channel-relay reply text (for relay sessions).
 */
function extractAssistantText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;

  const texts: string[] = [];
  const textPart = extractTextBlocks(content);
  if (textPart) texts.push(textPart);

  // Relay reply text lives in tool_use input, not text blocks
  for (const block of content) {
    if (
      block.type === "tool_use" &&
      block.name === "mcp__channel-relay__reply" &&
      block.input?.text
    ) {
      texts.push(String(block.input.text));
    }
  }

  return texts.join(" ").trim() || null;
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
  sessionId?: string,
  maxPairs: number = 3,
  dir?: string,
): Promise<ConversationPair[]> {
  let filePath: string | null = null;

  if (sessionId) {
    filePath = await findJsonlPath(sessionId);
  }
  if (!filePath && dir) {
    filePath = await findLatestJsonlForDir(dir);
  }
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

/**
 * Show recent history for a session in Telegram.
 */
export async function sendSwitchHistory(
  ctx: Context,
  info: { id?: string; dir: string },
): Promise<void> {
  const history = await getRecentHistory(info.id, 1, info.dir);
  const msg = formatHistoryMessage(history);
  if (msg) {
    await ctx.reply(msg, { parse_mode: "HTML" });
  }
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
