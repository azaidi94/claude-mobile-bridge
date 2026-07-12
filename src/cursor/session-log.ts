/**
 * Per-cursor-session JSONL writer.
 *
 * Cursor sessions don't have JSONL files like Claude Code does — they're
 * CDP-driven, so chat state lives in Cursor's DOM. To make history work
 * uniformly across sources, the bridge writes its observed user/AI
 * messages to a JSONL in a synthetic project dir under ~/.claude/projects.
 *
 * The format mirrors Claude Code's JSONL so the existing
 * readSessionHistory / formatHistoryMessage parsers handle it without
 * special-casing. The synthetic project dir name ("-cursor-sessions")
 * starts with "-" so the watcher's headless-session filter ignores it
 * (no port file → no desktop session registered).
 */

import { mkdir, appendFile, rename } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { debug } from "../logger";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const CURSOR_PROJECT_DIR = join(PROJECTS_DIR, "-cursor-sessions");

// Tail-truncation: keep at most this many lines in the JSONL. Once
// MAX_LINES + ROTATE_HYSTERESIS is exceeded we rewrite the file with
// only the last MAX_LINES — the hysteresis keeps the rewrite cost
// amortised over many appends.
const MAX_LINES = 2000;
const ROTATE_HYSTERESIS = 200;

export type CursorMessageSource = "telegram" | "web" | "cursor" | "terminal";

export class CursorSessionLog {
  private filePath: string;
  private dirReady: Promise<void>;
  /**
   * Lazy-initialised on first append from the existing file. Tracked
   * in-memory thereafter so we don't have to re-count on every write.
   * Resync is only needed if another process touches the file, which
   * doesn't happen — only this class writes here.
   */
  private lineCount: number | null = null;

  constructor(
    public readonly sessionName: string,
    public readonly sessionDir: string,
    /** Override the JSONL directory. Default uses the standard
     * ~/.claude/projects/-cursor-sessions location. Tests pass a tmp
     * dir to avoid touching real session history. */
    baseDir: string = CURSOR_PROJECT_DIR,
  ) {
    this.filePath = join(baseDir, `${sessionName}.jsonl`);
    this.dirReady = mkdir(baseDir, { recursive: true })
      .then(() => undefined)
      .catch((e) => {
        debug("cursor-log: mkdir failed", { error: (e as Error).message });
      });
  }

  /**
   * Persist a user message with its origin source so a later history
   * reload can label it correctly (📱 Telegram / 🌐 Web / 🖱 Cursor /
   * 🖥 Terminal). The default is "cursor" for messages typed natively
   * in the Composer.
   */
  async appendUser(
    text: string,
    source: CursorMessageSource = "cursor",
  ): Promise<void> {
    await this.append({
      type: "user",
      source,
      message: { role: "user", content: text },
      cwd: this.sessionDir,
      sessionId: this.sessionName,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Persist an assistant (AI) message. Source defaults to "cursor"
   * since assistant replies in a cursor session are always Cursor's AI.
   */
  async appendAssistant(
    text: string,
    source: CursorMessageSource = "cursor",
  ): Promise<void> {
    await this.append({
      type: "assistant",
      source,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
      cwd: this.sessionDir,
      sessionId: this.sessionName,
      timestamp: new Date().toISOString(),
    });
  }

  private async append(entry: object): Promise<void> {
    await this.dirReady;
    try {
      await appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf8");
      await this.maybeRotate();
    } catch (e) {
      debug("cursor-log: append failed", { error: (e as Error).message });
    }
  }

  /**
   * If the file has grown past MAX_LINES + ROTATE_HYSTERESIS, rewrite
   * it with only the last MAX_LINES lines. Atomic via tmp-then-rename
   * so a crash mid-truncate can never leave the JSONL half-written.
   */
  private async maybeRotate(): Promise<void> {
    if (this.lineCount === null) {
      this.lineCount = await this.countLines();
    } else {
      this.lineCount += 1;
    }
    if (this.lineCount <= MAX_LINES + ROTATE_HYSTERESIS) return;
    try {
      await this.truncateToLast(MAX_LINES);
      this.lineCount = MAX_LINES;
    } catch (e) {
      debug("cursor-log: rotate failed", { error: (e as Error).message });
      // Reset count so we retry on next append rather than spinning.
      this.lineCount = null;
    }
  }

  private async countLines(): Promise<number> {
    try {
      const text = await Bun.file(this.filePath).text();
      let n = 0;
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
      return n;
    } catch {
      return 0;
    }
  }

  private async truncateToLast(n: number): Promise<void> {
    const text = await Bun.file(this.filePath).text();
    const lines = text.split("\n");
    // Last element after split is "" if file ended with \n.
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    if (lines.length <= n) return;
    const tail = lines.slice(-n).join("\n") + "\n";
    const tmp = this.filePath + ".tmp";
    await Bun.write(tmp, tail);
    await rename(tmp, this.filePath);
  }
}
