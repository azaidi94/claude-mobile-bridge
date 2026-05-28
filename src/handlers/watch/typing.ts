/**
 * Per-topic typing-indicator state. The watch event router calls
 * touchWatchTyping on every tail event and stopWatchTyping on explicit
 * end-of-turn markers; a safety timeout guards crash-and-disconnect paths
 * where no end marker ever lands.
 */

import type { Api } from "grammy";
import { watchKey, type WatchKey } from "./registry";
import { safeAsync } from "../../utils/safe-async";

// Liveness typing: every tail event extends; turn_end / turn_boundary stop
// it explicitly. The safety timeout is a belt-and-suspenders fallback for
// crashes/disconnects where no end-of-turn marker ever lands.
const TYPING_SAFETY_MS = 120_000;
const typingState = new Map<
  WatchKey,
  { running: boolean; timeout: Timer | null }
>();

/** Signal activity — starts or extends the typing indicator. */
export function touchWatchTyping(
  botApi: Api,
  chatId: number,
  threadId: number,
): void {
  const key = watchKey(chatId, threadId);
  let entry = typingState.get(key);
  if (!entry) {
    entry = { running: false, timeout: null };
    typingState.set(key, entry);
  }

  // Reset idle timeout
  if (entry.timeout) clearTimeout(entry.timeout);
  entry.timeout = setTimeout(
    () => stopWatchTyping(chatId, threadId),
    TYPING_SAFETY_MS,
  );

  // Start loop if not already running
  if (entry.running) return;
  entry.running = true;
  const loop = async () => {
    while (entry!.running) {
      await safeAsync(
        "watch.typing_action",
        () =>
          botApi.sendChatAction(chatId, "typing", {
            message_thread_id: threadId,
          }),
        { severity: "debug" },
      );
      await Bun.sleep(4000);
    }
  };
  loop();
}

export function stopWatchTyping(chatId: number, threadId: number): void {
  const key = watchKey(chatId, threadId);
  const entry = typingState.get(key);
  if (entry) {
    entry.running = false;
    if (entry.timeout) clearTimeout(entry.timeout);
    typingState.delete(key);
  }
}

/** Test seam — read internal typing state (undefined when stopped). */
export function _isTypingForTests(chatId: number, threadId: number): boolean {
  return typingState.has(watchKey(chatId, threadId));
}

/** Test seam — clear all typing entries. Do NOT call from app code. */
export function _clearTypingForTests(): void {
  typingState.clear();
}
