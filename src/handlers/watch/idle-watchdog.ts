/**
 * Mid-turn idle watchdog + /run completion ping logic.
 *
 * The watchdog timer scans every active WatchState; if a state is `midTurn`
 * and has been silent past `WATCHDOG_IDLE_MS`, `handleIdleWatch` either auto-
 * sends "continue" (if `WATCHDOG_AUTO_CONTINUE`) or notifies the topic.
 *
 * `markPendingRunCompletion` + `firePendingRunCompletion` track the elapsed
 * time on `/run` so the user gets a "✅ /run done" ping when the next turn
 * completes (relay_reply / hook_summary).
 */

import type { Api } from "grammy";
import {
  WATCHDOG_AUTO_CONTINUE,
  WATCHDOG_IDLE_MS,
  WATCHDOG_TICK_MS,
} from "../../config";
import { escapeHtml, truncate } from "../../formatting";
import { debug, info, warn } from "../../logger";
import { getMessageBus } from "../../messaging";
import { watches, watchKey } from "./registry";
import type { MarkPendingResult, TailDisplayState, WatchState } from "./state";
import { sendWatchRelay } from "./relay-replies";

/**
 * Mark a (chatId, threadId) topic as having a pending /run completion. The
 * next relay_reply or hook_summary fires the completion ping. Caller must
 * pre-check the topic is being watched (or auto-watched) — without a
 * WatchState the completion event has nowhere to land.
 *
 * Returns "armed" on success, "no-watch" if no WatchState exists for the
 * topic, "already-pending" if a prior /run is still awaiting completion
 * (caller should surface this rather than silently dropping the prior ping).
 */
export function markPendingRunCompletion(
  chatId: number,
  threadId: number,
  prompt: string,
): MarkPendingResult {
  const state = watches.get(watchKey(chatId, threadId));
  if (!state) return "no-watch";
  if (state.pendingRunCompletion) return "already-pending";
  state.pendingRunCompletion = { startedAt: Date.now(), prompt };
  // Reset watchdog so a fresh idle clock runs for this run.
  state.watchdogFired = false;
  state.midTurn = true;
  state.lastEventTime = Date.now();
  return "armed";
}

/**
 * Clear a pending /run completion. Used to roll back arming when the relay
 * send that follows it fails — without this rollback a second /run would be
 * rejected as "already-pending" forever.
 */
export function clearPendingRunCompletion(
  chatId: number,
  threadId: number,
): void {
  const state = watches.get(watchKey(chatId, threadId));
  if (state) delete state.pendingRunCompletion;
}

/**
 * If the topic had a `/run` outstanding, send a completion ping with
 * elapsed time. Idempotent — fires at most once per /run via the
 * pendingRunCompletion field. No-op for non-WatchState (relay display).
 */
export function firePendingRunCompletion(
  _botApi: Api,
  state: TailDisplayState,
  threadId: number | undefined,
): void {
  const pending = (state as WatchState).pendingRunCompletion;
  if (!pending) return;
  delete (state as WatchState).pendingRunCompletion;

  const elapsedLabel = formatRunElapsedLabel(Date.now() - pending.startedAt);
  const message = `✅ /run done in ${elapsedLabel}\n<i>${escapeHtml(truncate(pending.prompt, 60))}</i>`;

  getMessageBus()
    .send({
      chatId: state.chatId,
      threadId,
      content: message,
      format: "html",
    })
    .catch((err) => debug(`run completion ping: ${err}`));
}

/**
 * Format a duration in milliseconds as a short human label: <60s, <60m, then
 * fractional hours. Exported as a test seam (covers s/m/h boundaries).
 */
export function formatRunElapsedLabel(elapsedMs: number): string {
  const elapsedSec = Math.round(elapsedMs / 1000);
  if (elapsedSec < 60) return `${elapsedSec}s`;
  if (elapsedSec < 3600) return `${Math.round(elapsedSec / 60)}m`;
  return `${(elapsedSec / 3600).toFixed(1)}h`;
}

// ============== Watchdog ==============

let watchdogTimer: Timer | null = null;

/**
 * Single global scanner that pings every active watch whose mid-turn idle
 * exceeds WATCHDOG_IDLE_MS. Idempotent across restarts — multiple
 * startWatchdog calls reuse the same timer.
 */
export function startWatchdog(botApi: Api): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    const now = Date.now();
    for (const state of watches.values()) {
      if (!state.midTurn) continue;
      if (state.watchdogFired) continue;
      if (now - state.lastEventTime < WATCHDOG_IDLE_MS) continue;
      state.watchdogFired = true;
      handleIdleWatch(botApi, state);
    }
  }, WATCHDOG_TICK_MS);
  info("watchdog: started", {
    idleMs: WATCHDOG_IDLE_MS,
    tickMs: WATCHDOG_TICK_MS,
    autoContinue: WATCHDOG_AUTO_CONTINUE,
  });
}

/** Stop the watchdog scanner. Used by tests + shutdown paths. */
export function stopWatchdog(): void {
  if (!watchdogTimer) return;
  clearInterval(watchdogTimer);
  watchdogTimer = null;
}

/**
 * Notify or auto-continue when a watch has been mid-turn-idle past the
 * threshold. WATCHDOG_AUTO_CONTINUE flips to a "continue" relay message;
 * default is a notify-only ping that surfaces in the topic.
 *
 * Exported as `_handleIdleWatchForTests` purely as a unit-test seam — the
 * production path is the watchdog timer in `startWatchdog`.
 */
export function _handleIdleWatchForTests(botApi: Api, state: WatchState): void {
  handleIdleWatch(botApi, state);
}

function handleIdleWatch(_botApi: Api, state: WatchState): void {
  const idleMin = Math.round((Date.now() - state.lastEventTime) / 60_000);
  const lastText = state.currentTextContent.trim().slice(0, 200);
  const tailQuote = lastText
    ? `\n<i>last said:</i> ${escapeHtml(lastText)}…`
    : "";

  warn("watchdog: idle session", {
    chatId: state.chatId,
    threadId: state.threadId,
    sessionName: state.sessionName,
    idleMin,
    autoContinue: WATCHDOG_AUTO_CONTINUE,
  });

  if (WATCHDOG_AUTO_CONTINUE) {
    sendWatchRelay(
      state.chatId,
      state.threadId,
      "watchdog",
      "continue",
      "watchdog_auto",
    )
      .then((ok) => {
        const msg = ok
          ? `🪫 idle ${idleMin}m in <b>${escapeHtml(state.sessionName)}</b> — auto-sent "continue".${tailQuote}`
          : `🪫 idle ${idleMin}m in <b>${escapeHtml(state.sessionName)}</b> — auto-continue failed (relay unavailable).${tailQuote}`;
        return getMessageBus().send({
          chatId: state.chatId,
          threadId: state.threadId,
          content: msg,
          format: "html",
        });
      })
      .catch((err) => debug(`watchdog auto-continue: ${err}`));
    return;
  }

  getMessageBus()
    .send({
      chatId: state.chatId,
      threadId: state.threadId,
      content: `🪫 idle ${idleMin}m in <b>${escapeHtml(state.sessionName)}</b>${tailQuote}`,
      format: "html",
    })
    .catch((err) => debug(`watchdog notify: ${err}`));
}
