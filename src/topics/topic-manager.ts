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
import { scanPortFiles, updatePortFile } from "../relay/discovery";
import { recordTopicCreated, recordTopicDeleted } from "./topic-ledger";

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

  private async findRelayPid(
    sessionName: string,
    sessionDir: string,
    sessionId?: string,
  ): Promise<number | undefined> {
    const portFiles = await scanPortFiles();
    if (sessionId) {
      const pf = portFiles.find((p) => p.sessionId === sessionId);
      if (pf) return pf.pid;
    }
    const byName = portFiles.find((p) => p.sessionName === sessionName);
    if (byName) return byName.pid;
    const byDir = portFiles.filter((p) => p.cwd === sessionDir);
    if (byDir.length === 1) return byDir[0]!.pid;
    return undefined;
  }

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
        const reusePid = await this.findRelayPid(
          sessionName,
          sessionDir,
          sessionId,
        );
        if (reusePid !== undefined) {
          updatePortFile(reusePid, {
            topicId: existing.topicId,
            topicName: sessionName,
          });
        }
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

      // Durable record so /cleanzombie can find this topic later even after
      // bot.log rotates or the store mapping is dropped.
      await recordTopicCreated({ topicId, sessionName, sessionDir, sessionId });

      const newPid = await this.findRelayPid(
        sessionName,
        sessionDir,
        sessionId,
      );
      if (newPid !== undefined) {
        updatePortFile(newPid, { topicId, topicName: sessionName });
      }

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
    // Record in the ledger regardless of the Telegram call's outcome — either
    // the topic is gone, or it was already gone; both mean "no longer ours".
    await recordTopicDeleted(mapping.topicId);
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
