/**
 * Re-anchor a session→topic binding on inbound (D1 of the origin-topic outbound
 * refactor). A Telegram message arrives with its origin topic id; when that
 * topic routes to session S we assert S↔T so a stale/wrong binding self-heals
 * the moment the user talks in the topic. The pure decision lives in
 * `../../topics/rebind`; this file owns the side effects (store + live watch).
 */

import { debug, warn } from "../../logger";
import {
  getSessionByTopic,
  getTopicBySession,
  updateTopicMapping,
} from "../../topics/topic-store";
import { topicRebindPlan } from "../../topics/rebind";
import { watchKey, watches } from "./registry";

/**
 * Move the live watch for `sessionName` (within `chatId`) to `newThreadId`.
 * Returns true if a watch was actually moved. Refuses to clobber a watch for a
 * *different* session already bound to the target topic — that conflict is left
 * for the identity-invariant checker to surface loudly.
 */
function rebindWatchThread(
  chatId: number,
  sessionName: string,
  newThreadId: number,
): boolean {
  for (const [, w] of watches) {
    if (w.chatId !== chatId || w.sessionName !== sessionName) continue;
    if (w.threadId === newThreadId) return false;
    const occupant = watches.get(watchKey(chatId, newThreadId));
    if (occupant && occupant.sessionName !== sessionName) {
      warn("identity: rebind blocked, topic held by another session", {
        chatId,
        sessionName,
        newThreadId,
        occupant: occupant.sessionName,
      });
      return false;
    }
    watches.delete(watchKey(chatId, w.threadId));
    w.threadId = newThreadId;
    watches.set(watchKey(chatId, newThreadId), w);
    return true;
  }
  return false;
}

/**
 * Assert that session `sessionName` is bound to topic `threadId` (the origin of
 * the inbound message). Updates the persisted mapping and moves the live watch
 * when they have diverged; no-op when already aligned.
 */
export function reassertSessionTopic(
  sessionName: string,
  chatId: number,
  threadId: number,
): void {
  const plan = topicRebindPlan(getTopicBySession(sessionName), threadId);
  if (plan.action !== "rebind") {
    // "noop": already aligned. "create": no mapping exists yet — we lack the
    // sessionDir/sessionId to forge one here; it's born at topic creation.
    return;
  }

  // Don't steal topic T from a different session. Overwriting our mapping's
  // topicId to T while another mapping already owns T would leave two mappings
  // sharing one topicId and corrupt getSessionByTopic (it returns the first
  // match). Surface the conflict loudly and leave store + watch untouched.
  const occupant = getSessionByTopic(threadId);
  if (occupant && occupant.sessionName !== sessionName) {
    warn("identity: rebind blocked, topic mapped to another session", {
      sessionName,
      conflictWith: occupant.sessionName,
      threadId,
      chatId,
    });
    return;
  }

  updateTopicMapping(sessionName, { topicId: threadId });
  debug("identity: rebound session to origin topic", {
    sessionName,
    from: plan.oldTopicId,
    to: threadId,
    chatId,
  });
  rebindWatchThread(chatId, sessionName, threadId);
}
