/**
 * Session tailer - watches a JSONL session file for new events.
 *
 * Tails from a given offset, parsing new lines as they're appended.
 * Uses fs.watch for instant detection + polling as backup.
 */

import { watch, type FSWatcher } from "fs";
import { stat } from "fs/promises";
import { formatToolStatus } from "../formatting";
import { debug, warn } from "../logger";

const POLL_INTERVAL_MS = 2_000;
const DEBOUNCE_MS = 200;

export type TailEventType =
  | "text"
  | "tool"
  | "thinking"
  | "user"
  | "relay_reply";

export interface TailEvent {
  type: TailEventType;
  content: string; // formatted display text
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

  constructor(filePath: string, callback: TailCallback) {
    this.filePath = filePath;
    this.offset = 0;
    this.callback = callback;
  }

  /**
   * Start tailing from current end of file.
   */
  async start(): Promise<void> {
    // Start from current EOF so we only see new events
    try {
      const s = await stat(this.filePath);
      this.offset = s.size;
    } catch {
      this.offset = 0;
    }

    // Watch for file changes
    try {
      this.watcher = watch(this.filePath, (event) => {
        if (this.stopped) return;
        if (event === "change") {
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => this.readNew(), DEBOUNCE_MS);
        }
      });
    } catch (err) {
      warn(`tailer: fs.watch failed: ${err}`);
    }

    // Backup polling
    this.pollTimer = setInterval(() => {
      if (!this.stopped) this.readNew();
    }, POLL_INTERVAL_MS);

    debug(`tailer: started at offset ${this.offset}`);
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
        const text = this.extractUserText(entry.message?.content);
        if (!text || text.includes('<channel source="channel-relay"'))
          return [];

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

      // Assistant message — emit all blocks
      if (entry.type === "assistant") {
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
            // Detect channel-relay reply/edit/react → emit as relay_reply
            if (
              block.name === "mcp__channel-relay__reply" ||
              block.name === "mcp__channel-relay__edit_message"
            ) {
              const text = String(input.text || "");
              if (text) {
                events.push({ type: "relay_reply", content: text });
                continue;
              }
            }
            // Skip relay react tool (just an emoji, not worth displaying)
            if (block.name === "mcp__channel-relay__react") continue;

            const toolDisplay = formatToolStatus(block.name, input);
            events.push({ type: "tool", content: toolDisplay });
          }

          if (block.type === "text" && block.text) {
            events.push({ type: "text", content: block.text });
          }
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
 * Find the JSONL file path for a session ID.
 */
export async function findSessionJsonlPath(
  sessionId: string,
): Promise<string | null> {
  const { readdir } = await import("fs/promises");
  const { join } = await import("path");
  const { homedir } = await import("os");

  const projectsDir = join(homedir(), ".claude", "projects");
  const filename = `${sessionId}.jsonl`;

  try {
    const projects = await readdir(projectsDir);
    for (const project of projects) {
      if (project.startsWith(".")) continue;
      const filePath = join(projectsDir, project, filename);
      const s = await stat(filePath).catch(() => null);
      if (s?.isFile()) return filePath;
    }
  } catch {
    // PROJECTS_DIR doesn't exist
  }
  return null;
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
    const { readFile } = await import("fs/promises");
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
            !text.includes('<channel source="channel-relay"') &&
            !text.includes("<local-command-stdout>")
          ) {
            lastUser = text.trim();
          }
        } else if (entry.type === "assistant") {
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
