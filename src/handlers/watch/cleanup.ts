/**
 * Watch teardown: stop a watch by topic or session name, plus
 * `notifySessionOffline` which is the watcher-driven "session went away"
 * path. These all share `cleanupWatch`, the function that detaches the
 * tailer, the relay callback, the cross-post subscription, the drift
 * interval, the typing indicator, and the usage record.
 */

import type { Api } from "grammy";
import { realpathSync } from "fs";
import { escapeHtml } from "../../formatting";
import { debug, info, warn } from "../../logger";
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
 * Stop every watch tailing `dir`, except the one on `exceptTopic` (the ralph
 * loop's own beat topic). Called when a ralph loop takes over a repo: its
 * ephemeral per-iteration claudes share the repo's session name, so an
 * already-attached session-topic watch would otherwise resolve that name to a
 * loop iteration and stream its transcript into the wrong topic. The drift /
 * auto-watch guards keep them from re-attaching while the loop owns the dir;
 * this tears down the ones already running. Realpath-compared so a symlinked
 * sessionDir still matches the loop's canonical repoPath. Returns the count.
 */
export function stopWatchesForDir(
  dir: string,
  botApi: Api,
  reason: string,
  exceptTopic?: { chatId: number; threadId: number },
): number {
  const target = realpathOr(dir);
  let stopped = 0;
  // Snapshot the entries first — stopWatching mutates the `watches` map.
  for (const w of [...watches.values()]) {
    if (
      exceptTopic &&
      w.chatId === exceptTopic.chatId &&
      w.threadId === exceptTopic.threadId
    )
      continue;
    if (realpathOr(w.sessionDir) !== target) continue;
    stopWatching(w.chatId, w.threadId, botApi, reason);
    stopped++;
  }
  return stopped;
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
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
      .catch((err) =>
        debug("watch offline notify failed", {
          err: String(err),
          chatId,
          topic: threadId,
          session: state.sessionName,
        }),
      );

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
    } catch {
      // silently ok: test-reset path; tailer may already be stopped
    }
    state.relayCleanup?.();
    if (state.idCheckInterval) clearInterval(state.idCheckInterval);
    forgetUsage(state.sessionId);
  }
  watches.clear();
  _clearTypingForTests();
}
