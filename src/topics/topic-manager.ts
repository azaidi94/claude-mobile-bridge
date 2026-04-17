/**
 * Topic lifecycle manager.
 * Creates, deletes, and renames Telegram forum topics for sessions.
 * Coordinates with the topic store for persistence.
 */

import type { Api } from "grammy";
import {
  addTopicMapping,
  removeTopicMapping,
  getTopicBySession,
  updateTopicMapping,
  getTopicStore,
} from "./topic-store";
import { info, warn, debug } from "../logger";
import { getRecentHistory, formatHistoryMessage } from "../sessions/history";

interface ReconcileSession {
  name: string;
  dir: string;
  id?: string;
}

export class TopicManager {
  constructor(
    private api: Api,
    private chatId: number,
  ) {}

  /** Update the target chat ID (e.g. when switching from DM to group). */
  setChatId(chatId: number): void {
    this.chatId = chatId;
  }

  getChatId(): number {
    return this.chatId;
  }

  async createTopic(
    sessionName: string,
    sessionDir: string,
    sessionId?: string,
  ): Promise<number | undefined> {
    const existing = getTopicBySession(sessionName);
    if (existing) {
      // Verify the topic still exists in Telegram
      try {
        await this.api.sendMessage(
          this.chatId,
          `🟢 <b>${sessionName}</b> online`,
          { parse_mode: "HTML", message_thread_id: existing.topicId },
        );
        updateTopicMapping(sessionName, { isOnline: true, sessionId });
        debug(
          `topic-manager: reusing topic ${existing.topicId} for ${sessionName}`,
        );
        return existing.topicId;
      } catch (err) {
        if (String(err).includes("message thread not found")) {
          warn(
            `topic-manager: stale topic ${existing.topicId} for ${sessionName}, recreating`,
          );
          removeTopicMapping(sessionName);
        } else {
          throw err;
        }
      }
    }

    try {
      const result = await this.api.createForumTopic(
        this.chatId,
        sessionName,
        {},
      );
      const topicId = result.message_thread_id;

      addTopicMapping({
        topicId,
        sessionName,
        sessionDir,
        sessionId,
        isOnline: true,
        createdAt: new Date().toISOString(),
      });

      info(`topic-manager: created topic ${topicId} for ${sessionName}`);

      // Best-effort: show recent history in the new topic
      try {
        const history = await getRecentHistory(sessionId, 3, sessionDir);
        if (history.length > 0) {
          const formatted = formatHistoryMessage(history);
          await this.api.sendMessage(this.chatId, formatted, {
            parse_mode: "HTML",
            message_thread_id: topicId,
          });
        }
      } catch {
        // History is best-effort — don't fail topic creation
      }

      return topicId;
    } catch (err) {
      warn(`topic-manager: createForumTopic failed for ${sessionName}: ${err}`);
      return undefined;
    }
  }

  async deleteTopic(sessionName: string): Promise<void> {
    const mapping = getTopicBySession(sessionName);
    if (!mapping) return;

    try {
      await this.api.deleteForumTopic(this.chatId, mapping.topicId);
      info(
        `topic-manager: deleted topic ${mapping.topicId} for ${sessionName}`,
      );
    } catch (err) {
      warn(`topic-manager: deleteForumTopic failed for ${sessionName}: ${err}`);
    }

    removeTopicMapping(sessionName);
  }

  async updateTopicStatus(sessionName: string, online: boolean): Promise<void> {
    const mapping = getTopicBySession(sessionName);
    if (!mapping) return;

    updateTopicMapping(sessionName, { isOnline: online });
    debug(`topic-manager: updated ${sessionName} online=${online}`);
  }

  async reconcile(liveSessions: ReconcileSession[]): Promise<void> {
    const store = getTopicStore();
    const liveNames = new Set(liveSessions.map((s) => s.name));

    // Delete topics for sessions that no longer exist
    const staleNames = store.topics
      .filter((m) => !liveNames.has(m.sessionName))
      .map((m) => m.sessionName);
    await Promise.allSettled(staleNames.map((n) => this.deleteTopic(n)));

    await Promise.allSettled(
      liveSessions.map((s) => {
        const existing = getTopicBySession(s.name);
        if (!existing) return this.createTopic(s.name, s.dir, s.id);
        if (!existing.isOnline) return this.updateTopicStatus(s.name, true);
        return Promise.resolve();
      }),
    );

    info(
      `topic-manager: reconciled ${liveSessions.length} session(s), ${store.topics.length} topic(s)`,
    );
  }
}
