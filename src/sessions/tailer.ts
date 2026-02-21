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

export type TailEventType = "text" | "tool" | "thinking" | "user";

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
        const event = this.parseLine(line);
        if (event) {
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
   * Parse a JSONL line into a TailEvent, or null if not relevant.
   */
  private parseLine(line: string): TailEvent | null {
    try {
      const entry = JSON.parse(line);

      // Skip sidechain messages
      if (entry.isSidechain) return null;

      // User message from desktop
      if (entry.type === "user") {
        const text = this.extractUserText(entry.message?.content);
        if (text) {
          return { type: "user", content: text };
        }
        return null;
      }

      // Assistant message
      if (entry.type === "assistant") {
        const content = entry.message?.content;
        if (!Array.isArray(content)) return null;

        // Process blocks - emit the most interesting one
        for (const block of content) {
          if (block.type === "thinking" && block.thinking) {
            const preview =
              block.thinking.length > 200
                ? block.thinking.slice(0, 200) + "..."
                : block.thinking;
            return { type: "thinking", content: preview };
          }

          if (block.type === "tool_use") {
            const toolDisplay = formatToolStatus(
              block.name,
              (block.input as Record<string, unknown>) || {},
            );
            return { type: "tool", content: toolDisplay };
          }

          if (block.type === "text" && block.text) {
            return { type: "text", content: block.text };
          }
        }

        return null;
      }
    } catch {
      // Malformed JSON line
    }
    return null;
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
