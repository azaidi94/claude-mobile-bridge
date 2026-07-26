/**
 * Poll tmux-hosted Claude sessions for a modal that popped while the agent was
 * working autonomously — a Bash-permission prompt, an auto-compact confirmation,
 * a sensitive-file-edit gate.
 *
 * Without this, the send guard only notices a modal when the user next tries to
 * send something, which may be hours later. The session sits blocked and silent.
 *
 * Gate A only (`isModalPresent`). Gate B returns "no bar" on any transient render
 * — startup, a mid-tick refresh, an empty capture — and a watchdog gated on it
 * would alert constantly.
 */

import { isModalPresent } from "./modal-detect";
import { capturePane } from "./exec";
import { warn, info } from "../logger";

/** Independent of the session watcher's 60s poll — far too slow for "you're blocked". */
const WATCHDOG_INTERVAL_MS = 15_000;

export interface WatchdogRow {
  launchUuid?: string;
  pane: string;
}

/**
 * Pure. Decide which sessions deserve an alert this tick.
 *
 * Dedup is on the PANE TEXT itself: an unchanged pane on the next tick is a
 * no-op. When a session leaves the modal, its entry is dropped, so a later
 * second modal alerts again.
 *
 * A capture that throws or returns "" yields no alert — an unreadable pane must
 * never raise one — and never aborts the other rows.
 */
export function planModalAlerts(
  rows: WatchdogRow[],
  capture: (pane: string) => string,
  lastAlertedPane: Map<string, string>,
): {
  alerts: Array<{ launchUuid: string; pane: string }>;
  nextMap: Map<string, string>;
} {
  const alerts: Array<{ launchUuid: string; pane: string }> = [];
  const nextMap = new Map(lastAlertedPane);

  for (const row of rows) {
    if (!row.launchUuid) continue; // no stable key → no dedup, no keyboard
    let pane = "";
    try {
      pane = capture(row.pane);
    } catch (e) {
      warn(`watchdog: capture threw for pane ${row.pane}: ${String(e)}`);
      continue;
    }

    if (!isModalPresent(pane)) {
      nextMap.delete(row.launchUuid);
      continue;
    }
    if (nextMap.get(row.launchUuid) === pane) continue; // already alerted, unchanged

    nextMap.set(row.launchUuid, pane);
    alerts.push({ launchUuid: row.launchUuid, pane });
  }

  return { alerts, nextMap };
}

/**
 * Start the poll loop. Returns a stop function.
 *
 * Every tick is wrapped: a dead watchdog is silent, which is the worst failure
 * mode, so any throw is logged and the timer survives.
 */
export function startModalWatchdog(): () => void {
  let lastAlertedPane = new Map<string, string>();
  /**
   * Re-entrancy guard. `setInterval` does not await `tick`, and a tick can
   * outrun the 15s interval: `listTmuxRows` plus one `capture-pane` per session
   * each carry a 5s timeout, so a wedged tmux with 4 sessions takes ~25s. Two
   * overlapping ticks would read the same `lastAlertedPane` (the first has not
   * reassigned it yet), both judge the modal new, and both alert — duplicate
   * pings exactly when tmux is already unhealthy. Skip instead of queueing;
   * the next tick is only 15s away.
   */
  let ticking = false;

  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      // Imported lazily: tmux.ts pulls in grammy + the topic store, and importing
      // it at module load would cycle back through handlers/commands.
      const { listTmuxRows, rowLabel, fitEscapedCapture } =
        await import("../handlers/commands/tmux");
      const { buildTuiKeyboard } = await import("./keys");
      const { getTopicByLaunchUuid, getChatId } =
        await import("../topics/topic-store");
      const { getMessageBus } = await import("../messaging");

      const chatId = getChatId();
      if (!chatId) return; // topic store not initialised yet — nowhere to alert

      const { rows, error } = await listTmuxRows();
      if (error) return;

      const { alerts, nextMap } = planModalAlerts(
        rows,
        (pane) => capturePane({ pane }),
        lastAlertedPane,
      );
      lastAlertedPane = nextMap;

      for (const alert of alerts) {
        const topic = getTopicByLaunchUuid(alert.launchUuid);
        if (!topic) continue; // no topic to alert into
        const row = rows.find((r) => r.launchUuid === alert.launchUuid);
        const label = row ? rowLabel(row) : alert.launchUuid.slice(0, 8);
        info(`watchdog: modal detected in ${label}`);
        await getMessageBus().send({
          chatId,
          threadId: topic.topicId,
          content:
            `⚠️ <b>${label} is blocked on a dialog.</b>\n\n` +
            `<pre>${fitEscapedCapture(alert.pane)}</pre>`,
          format: "html",
          replyMarkup: {
            inline_keyboard: buildTuiKeyboard(alert.launchUuid).inline_keyboard,
          },
        });
      }
    } catch (e) {
      warn(`watchdog: tick failed: ${String(e)}`);
    } finally {
      // MUST be a finally: the try body has early returns (chatId unset, tmux
      // query error) and a catch. Releasing only on the happy path would wedge
      // `ticking` true forever after the first throw, and a silently dead
      // watchdog is the worst failure mode this module has.
      ticking = false;
    }
  };

  const handle = setInterval(() => void tick(), WATCHDOG_INTERVAL_MS);
  return () => clearInterval(handle);
}
