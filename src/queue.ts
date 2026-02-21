/**
 * Task Queue for Claude Telegram Bot.
 *
 * Enables queuing multiple tasks for sequential execution.
 * Each task is sent to Claude individually with progress notifications.
 */

import type { Context } from "grammy";
import type { Bot } from "grammy";
import type { QueueTask, QueueTaskStatus } from "./types";
import { session } from "./session";
import { StreamingState, createStatusCallback } from "./handlers/streaming";
import { startTypingIndicator } from "./utils";
import { escapeHtml } from "./formatting";
import { getActiveSession } from "./sessions";
import { info, debug, warn } from "./logger";

// Global active queue (only one queue can run at a time)
let activeQueue: TaskQueue | null = null;

export function getActiveQueue(): TaskQueue | null {
  return activeQueue;
}

/**
 * Parse a task list from user input text.
 * Supports numbered lists, bulleted lists, and plain newlines.
 */
export function parseTasks(text: string): string[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const tasks: string[] = [];

  for (const line of lines) {
    // Strip numbered prefix: "1. ", "1) ", "1: "
    const numbered = line.replace(/^\d+[\.\)\:]\s*/, "");
    // Strip bullet prefix: "- ", "* ", "• "
    const cleaned = numbered.replace(/^[-\*•]\s*/, "");
    if (cleaned) {
      tasks.push(cleaned);
    }
  }

  return tasks;
}

const STATUS_ICONS: Record<QueueTaskStatus, string> = {
  pending: "⏳",
  running: "🔄",
  completed: "✅",
  failed: "❌",
  skipped: "⏭️",
};

export class TaskQueue {
  tasks: QueueTask[];
  currentTaskIndex: number = -1;
  cancelled: boolean = false;
  startedAt: number;
  completedAt?: number;

  private chatId: number;
  private userId: number;
  private username: string;
  private progressMessageId: number | null = null;

  constructor(
    descriptions: string[],
    chatId: number,
    userId: number,
    username: string,
  ) {
    this.tasks = descriptions.map((desc, i) => ({
      index: i,
      description: desc,
      status: "pending" as QueueTaskStatus,
    }));
    this.chatId = chatId;
    this.userId = userId;
    this.username = username;
    this.startedAt = Date.now();
  }

  get isRunning(): boolean {
    return (
      !this.cancelled &&
      this.currentTaskIndex >= 0 &&
      this.currentTaskIndex < this.tasks.length
    );
  }

  get completedCount(): number {
    return this.tasks.filter((t) => t.status === "completed").length;
  }

  get failedCount(): number {
    return this.tasks.filter((t) => t.status === "failed").length;
  }

  /**
   * Cancel the queue. Current task will finish, remaining are skipped.
   */
  cancel(): void {
    this.cancelled = true;
    // Skip remaining pending tasks
    for (const task of this.tasks) {
      if (task.status === "pending") {
        task.status = "skipped";
      }
    }
    // Stop current running query
    if (session.isRunning) {
      session.stop().catch(() => {});
    }
  }

  /**
   * Skip the current running task.
   */
  skipCurrent(): void {
    if (session.isRunning) {
      session.stop().catch(() => {});
    }
  }

  /**
   * Format current progress as HTML.
   */
  formatProgress(): string {
    const lines: string[] = [`📋 <b>Queue Progress</b>\n`];

    for (const task of this.tasks) {
      const icon = STATUS_ICONS[task.status];
      const desc = escapeHtml(
        task.description.length > 60
          ? task.description.slice(0, 60) + "..."
          : task.description,
      );
      lines.push(`${icon} ${task.index + 1}. ${desc}`);
    }

    const elapsed = Math.round((Date.now() - this.startedAt) / 1000);
    lines.push(
      `\n⏱️ ${elapsed}s · ${this.completedCount}/${this.tasks.length} done`,
    );

    return lines.join("\n");
  }

  /**
   * Format final summary as HTML.
   */
  formatSummary(): string {
    const lines: string[] = [];

    if (this.cancelled) {
      lines.push(`🛑 <b>Queue Cancelled</b>\n`);
    } else if (this.failedCount > 0) {
      lines.push(`⚠️ <b>Queue Complete (with errors)</b>\n`);
    } else {
      lines.push(`✅ <b>Queue Complete</b>\n`);
    }

    for (const task of this.tasks) {
      const icon = STATUS_ICONS[task.status];
      const desc = escapeHtml(
        task.description.length > 60
          ? task.description.slice(0, 60) + "..."
          : task.description,
      );
      let line = `${icon} ${task.index + 1}. ${desc}`;
      if (task.status === "failed" && task.error) {
        line += `\n   └─ ${escapeHtml(task.error.slice(0, 80))}`;
      }
      if (task.completedAt && task.startedAt) {
        const dur = Math.round((task.completedAt - task.startedAt) / 1000);
        line += ` (${dur}s)`;
      }
      lines.push(line);
    }

    const totalElapsed = Math.round(
      ((this.completedAt || Date.now()) - this.startedAt) / 1000,
    );
    lines.push(
      `\n📊 ${this.completedCount} completed · ${this.failedCount} failed · ${totalElapsed}s total`,
    );

    return lines.join("\n");
  }

  /**
   * Process all tasks sequentially.
   */
  async process(ctx: Context): Promise<void> {
    activeQueue = this;
    info(`queue: starting ${this.tasks.length} tasks`);

    try {
      // Sync session with registry if needed
      if (!session.sessionName) {
        const active = getActiveSession();
        if (active) {
          session.loadFromRegistry(active.info);
        }
      }

      // Send initial progress message
      const progressMsg = await ctx.reply(this.formatProgress(), {
        parse_mode: "HTML",
      });
      this.progressMessageId = progressMsg.message_id;

      for (let i = 0; i < this.tasks.length; i++) {
        if (this.cancelled) break;

        const task = this.tasks[i]!;
        this.currentTaskIndex = i;
        task.status = "running";
        task.startedAt = Date.now();

        // Update progress message
        await this.updateProgress(ctx);

        // Send task notification
        await ctx.reply(
          `🔄 <b>Task ${i + 1}/${this.tasks.length}</b>\n${escapeHtml(task.description)}`,
          { parse_mode: "HTML" },
        );

        // Process the task
        const stopProcessing = session.startProcessing();
        const typing = startTypingIndicator(ctx);
        const state = new StreamingState();
        const statusCallback = createStatusCallback(ctx, state);

        try {
          const response = await session.sendMessageStreaming(
            task.description,
            this.username,
            this.userId,
            statusCallback,
            this.chatId,
            ctx,
          );

          task.status = "completed";
          task.response = response.slice(0, 500);
          task.completedAt = Date.now();

          debug(`queue task ${i + 1}: completed`);
        } catch (error) {
          const errorStr = String(error);
          const isAbort =
            errorStr.includes("abort") || errorStr.includes("cancel");

          // Clean up partial messages
          for (const toolMsg of state.toolMessages) {
            try {
              await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
            } catch {
              // Ignore cleanup errors
            }
          }

          if (isAbort && this.cancelled) {
            // Queue was cancelled
            task.status = "skipped";
            task.completedAt = Date.now();
            debug(`queue task ${i + 1}: cancelled`);
          } else if (isAbort) {
            // Task was skipped via skip button
            task.status = "skipped";
            task.completedAt = Date.now();
            debug(`queue task ${i + 1}: skipped`);
            // Clear stop state so next task can proceed
            session.clearStopRequested();
          } else {
            task.status = "failed";
            task.error = errorStr.slice(0, 200);
            task.completedAt = Date.now();
            warn(`queue task ${i + 1}: failed - ${errorStr.slice(0, 100)}`);

            // On crash, try to recover session for remaining tasks
            if (errorStr.includes("exited with code")) {
              await session.kill();
              await ctx.reply(
                `⚠️ Claude crashed on task ${i + 1}, recovering...`,
              );
            }
          }
        } finally {
          stopProcessing();
          typing.stop();
        }

        // Update progress after each task
        await this.updateProgress(ctx);
      }

      // Queue finished
      this.completedAt = Date.now();
      info(
        `queue: done (${this.completedCount}/${this.tasks.length} completed)`,
      );

      // Send summary
      await ctx.reply(this.formatSummary(), { parse_mode: "HTML" });
    } finally {
      activeQueue = null;
    }
  }

  /**
   * Update the progress message in-place.
   */
  private async updateProgress(ctx: Context): Promise<void> {
    if (!this.progressMessageId) return;

    try {
      await ctx.api.editMessageText(
        this.chatId,
        this.progressMessageId,
        this.formatProgress(),
        { parse_mode: "HTML" },
      );
    } catch {
      // Progress message may have been deleted or is unchanged
    }
  }
}
