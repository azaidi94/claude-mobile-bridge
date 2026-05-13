/**
 * Bridge health tracker — flips to "offline" after consecutive Telegram API
 * network failures so other modules can drop or coalesce outbound work
 * instead of letting it pile up in grammy's send queue.
 *
 * Wired as a grammy transformer in bot.ts, installed AFTER autoRetry so we
 * only see failures that have already exhausted their retry budget.
 *
 * Only counts `HttpError` (network/transport). Skips `GrammyError`
 * (TG returned a status) — those mean TG is reachable, just rejecting a
 * specific call (e.g. user blocked the bot), which shouldn't trip global
 * offline.
 */

import type { Api } from "grammy";
import { HttpError } from "grammy";
import { info, warn } from "./logger";

type Listener = (online: boolean) => void;

const FAILURE_THRESHOLD = 3;

let online = true;
let consecutiveFailures = 0;
const listeners = new Set<Listener>();

export function isBridgeOnline(): boolean {
  return online;
}

export function onBridgeChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setOnline(value: boolean): void {
  if (online === value) return;
  online = value;
  for (const l of listeners) {
    try {
      l(value);
    } catch (err) {
      warn(`bridge-health: listener threw: ${err}`);
    }
  }
}

export function installBridgeHealthTransformer(api: Api): void {
  api.config.use(async (prev, method, payload, signal) => {
    try {
      const result = await prev(method, payload, signal);
      consecutiveFailures = 0;
      if (!online) {
        info("bridge-health: bridge recovered");
        setOnline(true);
      }
      return result;
    } catch (err) {
      if (err instanceof HttpError) {
        consecutiveFailures++;
        if (online && consecutiveFailures >= FAILURE_THRESHOLD) {
          warn(
            `bridge-health: bridge offline (${consecutiveFailures} consecutive HttpError)`,
          );
          setOnline(false);
        }
      }
      throw err;
    }
  });
}

export function _resetForTests(): void {
  online = true;
  consecutiveFailures = 0;
  listeners.clear();
}
