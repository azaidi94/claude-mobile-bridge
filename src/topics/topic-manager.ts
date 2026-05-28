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
import { safeAsync } from "../utils/safe-async";
import { getRecentHistory, formatHistoryMessage } from "../sessions/history";
import { scanPortFiles, updatePortFile } from "../relay/discovery";
import { recordTopicCreated, recordTopicDeleted } from "./topic-ledger";
import { getMessageBus } from "../messaging";

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
      // Verify the topic still exists in Telegram. The bus swallows TG errors
      // and reports them as `dropped: "error"` with `reason`; we re-throw on
      // "message thread not found" so the catch below can recreate the topic.
      const onlineRes = await getMessageBus().send({
        chatId: this.chatId,
        threadId: existing.topicId,
        content: `🟢 <b>${sessionName}</b> online`,
        format: "html",
      });
      if ("dropped" in onlineRes && onlineRes.dropped === "error") {
        const reason = onlineRes.reason ?? "";
        if (reason.includes("message thread not found")) {
          warn(
            `topic-manager: stale topic ${existing.topicId} for ${sessionName}, recreating`,
          );
          removeTopicMapping(sessionName);
        } else {
          throw new Error(reason);
        }
      } else {
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
          await getMessageBus().send({
            chatId: this.chatId,
            threadId: topicId,
            content: formatted,
            format: "html",
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

    const ok = await safeAsync(
      "topic.delete",
      async () => {
        await this.api.deleteForumTopic(this.chatId, mapping.topicId);
        return true;
      },
      { fields: { session: sessionName, topic_id: mapping.topicId } },
    );
    if (ok) {
      info(
        `topic-manager: deleted topic ${mapping.topicId} for ${sessionName}`,
      );
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

    // Delete topics for sessions that no longer exist — but ONLY for
    // CC/desktop sessions, whose liveness `liveSessions` (derived from the
    // relay port-file scan) authoritatively knows. Cursor topics are NOT
    // ours to prune here: at startup the cursor-bridge's syncBridges runs
    // async on a 5s timer and hasn't re-registered its sessions yet, so
    // every cursor-* topic would look "stale" and get deleted — then
    // recreated seconds later with a new id. The cursor-bridge owns cursor
    // topic lifecycle (closed-window cleanup) and /cleanzombie prunes stale
    // ones with real CDP-liveness info. (Prefix sniff until phase 5 unifies
    // Session sources.)
    const staleNames = store.topics
      .filter((m) => !liveNames.has(m.sessionName))
      .filter((m) => !m.sessionName.startsWith("cursor-"))
      .map((m) => m.sessionName);
    await Promise.allSettled(staleNames.map((n) => this.deleteTopic(n)));

    // Route every live session through createTopic, which validates an
    // existing mapping by probing its topic: a healthy topic is reused (and
    // marked online), a topic deleted in Telegram ("message thread not found")
    // is dropped and recreated, and a session with no mapping gets a fresh
    // topic. Trusting existing+online mappings without probing left stale
    // entries unhealed across restarts (topic deleted mid-run → every send
    // dropped with "message thread not found").
    await Promise.allSettled(
      liveSessions.map((s) => this.createTopic(s.name, s.dir, s.id)),
    );

    info(
      `topic-manager: reconciled ${liveSessions.length} session(s), ${store.topics.length} topic(s)`,
    );
  }
}
