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
import { getTopicsEnabled } from "../settings";
import { info, warn, debug } from "../logger";
import { getRecentHistory, formatHistoryMessage } from "../sessions/history";

interface ReconcileSession {
  name: string;
  dir: string;
  id?: string;
}

function statusEmoji(online: boolean, thinking = false): string {
  if (thinking) return "🟡";
  return online ? "🟢" : "🔴";
}

function topicName(
  sessionName: string,
  online: boolean,
  thinking = false,
): string {
  return `${statusEmoji(online, thinking)} ${sessionName}`;
}

export class TopicManager {
  constructor(
    private api: Api,
    private chatId: number,
  ) {}

  async createTopic(
    sessionName: string,
    sessionDir: string,
    sessionId?: string,
  ): Promise<number | undefined> {
    if (!getTopicsEnabled()) return undefined;

    const existing = getTopicBySession(sessionName);
    if (existing) {
      debug(`topic-manager: topic already exists for ${sessionName}`);
      return existing.topicId;
    }

    try {
      const result = await this.api.createForumTopic(
        this.chatId,
        topicName(sessionName, true),
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

  async updateTopicStatus(
    sessionName: string,
    online: boolean,
    thinking = false,
  ): Promise<void> {
    const mapping = getTopicBySession(sessionName);
    if (!mapping) return;

    const newName = topicName(sessionName, online, thinking);

    try {
      await this.api.editForumTopic(this.chatId, mapping.topicId, {
        name: newName,
      });
      updateTopicMapping(sessionName, { isOnline: online });
      debug(`topic-manager: updated ${sessionName} → ${newName}`);
    } catch (err) {
      if (String(err).includes("TOPIC_NOT_MODIFIED")) return;
      warn(`topic-manager: editForumTopic failed for ${sessionName}: ${err}`);
    }
  }

  async reconcile(liveSessions: ReconcileSession[]): Promise<void> {
    if (!getTopicsEnabled()) return;

    const store = getTopicStore();
    const liveNames = new Set(liveSessions.map((s) => s.name));

    for (const mapping of store.topics) {
      if (!liveNames.has(mapping.sessionName) && mapping.isOnline) {
        await this.updateTopicStatus(mapping.sessionName, false);
      }
    }

    for (const session of liveSessions) {
      const existing = getTopicBySession(session.name);
      if (!existing) {
        await this.createTopic(session.name, session.dir, session.id);
      } else if (!existing.isOnline) {
        await this.updateTopicStatus(session.name, true);
      }
    }

    info(
      `topic-manager: reconciled ${liveSessions.length} session(s), ${store.topics.length} topic(s)`,
    );
  }
}
