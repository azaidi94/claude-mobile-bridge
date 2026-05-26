/**
 * Watch teardown: stop a watch by topic or session name, plus
 * `notifySessionOffline` which is the watcher-driven "session went away"
 * path. These all share `cleanupWatch`, the function that detaches the
 * tailer, the relay callback, the cross-post subscription, the drift
 * interval, the typing indicator, and the usage record.
 */

import type { Api } from "grammy";
import { escapeHtml } from "../../formatting";
import { info, warn } from "../../logger";
import { getMessageBus } from "../../messaging";
import { getSession, setActiveSession, getSessionState } from "../../sessions";
import { forgetUsage } from "../../sessions/context-usage";
import { blacklistKilledSessionId, watchKey, watches } from "./registry";
import type { WatchState } from "./state";
import { finalizeTextMessage } from "./text-renderer";
import { _clearTypingForTests, stopWatchTyping } from "./typing";

/** Stop tailer, relay callbacks, typing indicator; remove from watches map. */
function cleanupWatch(state: WatchState): void {
  state.tailer?.stop();
  state.relayCleanup?.();
  state.unsubCrossPost?.();
  if (state.idCheckInterval) clearInterval(state.idCheckInterval);
  stopWatchTyping(state.chatId, state.threadId);
  forgetUsage(state.sessionId);
  watches.delete(watchKey(state.chatId, state.threadId));
}

export function stopWatching(
  chatId: number,
  threadId: number,
  botApi?: Api,
  reason = "manual",
): WatchState | undefined {
  const state = watches.get(watchKey(chatId, threadId));
  if (state) {
    // Flush pending text before stopping
    if (botApi && state.currentTextMsg && !state.segmentDone) {
      finalizeTextMessage(botApi, state);
    }
    cleanupWatch(state);
    info("watch: stopped", {
      chatId,
      threadId,
      sessionName: state.sessionName,
      sessionId: state.sessionId,
      sessionDir: state.sessionDir,
      reason,
    });
  }
  return state;
}

/**
 * Stop watching the session whose sessionName matches `sessionName`.
 * Used by killSession so only the killed session's watch is stopped,
 * leaving other topics' watches intact — including sibling sessions that
 * share a sessionDir.
 */
export function stopWatchByName(
  sessionName: string,
  botApi?: Api,
  reason = "byName",
): WatchState | undefined {
  for (const [, state] of watches) {
    if (state.sessionName === sessionName) {
      if (botApi && state.currentTextMsg && !state.segmentDone) {
        finalizeTextMessage(botApi, state);
      }
      if (reason === "kill") blacklistKilledSessionId(state.sessionId);
      cleanupWatch(state);
      info("watch: stopped by name", {
        chatId: state.chatId,
        threadId: state.threadId,
        sessionName,
        sessionDir: state.sessionDir,
        reason,
      });
      return state;
    }
  }
  return undefined;
}

/**
 * Notify watch handlers that a session went offline.
 * Called from the watcher notification system.
 */
export function notifySessionOffline(_botApi: Api, sessionName: string): void {
  for (const [, state] of watches) {
    if (state.sessionName !== sessionName) continue;
    const { chatId, threadId } = state;
    cleanupWatch(state);

    const sessionInfo = getSession(state.sessionName);
    if (sessionInfo) {
      getSessionState(state.sessionName).loadFromRegistry(sessionInfo);
      setActiveSession(state.sessionName);
    }

    getMessageBus()
      .send({
        chatId,
        threadId,
        content: `📴 <b>${escapeHtml(state.sessionName)}</b> went offline.\nSend a message to continue here.`,
        format: "html",
      })
      .catch((err) => warn(`watch offline notify: ${err}`));

    warn("watch: session went offline", {
      chatId,
      threadId,
      sessionName: state.sessionName,
      sessionId: state.sessionId,
      sessionDir: state.sessionDir,
      readyForResume: Boolean(sessionInfo),
    });
    return;
  }
}

/** Test seam — clear internal watch + typing state. Do NOT call from app code. */
export function _resetWatchesForTests(): void {
  for (const [, state] of watches) {
    try {
      state.tailer?.stop();
    } catch {}
    state.relayCleanup?.();
    if (state.idCheckInterval) clearInterval(state.idCheckInterval);
    forgetUsage(state.sessionId);
  }
  watches.clear();
  _clearTypingForTests();
}
