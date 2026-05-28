/**
 * Active-watch registry: the `watches` Map plus tiny pure key-helpers and
 * read-only lookups. Single source of truth for "is this topic watching?"
 * across the watch/ submodules.
 *
 * Also owns the `killedSessionIds` TTL Map (shared by the drift detector in
 * `jsonl-tailer.ts` and the lifecycle's stopWatchByName).
 */

import type { WatchState } from "./state";

// Active watches: "chatId:threadId" -> WatchState
export type WatchKey = `${number}:${number}`;
export const watches = new Map<WatchKey, WatchState>();

export function watchKey(chatId: number, threadId: number): WatchKey {
  return `${chatId}:${threadId}`;
}

export function watchKeyChatPrefix(chatId: number): string {
  return `${chatId}:`;
}

// Recently-killed session ids. A sibling sharing the dir could otherwise
// drift onto the dying session's JSONL (still the newest for a moment).
const KILLED_ID_TTL_MS = 120_000;
export const killedSessionIds = new Map<string, Timer>();

export function blacklistKilledSessionId(sessionId: string): void {
  if (!sessionId) return;
  const existing = killedSessionIds.get(sessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(
    () => killedSessionIds.delete(sessionId),
    KILLED_ID_TTL_MS,
  );
  killedSessionIds.set(sessionId, timer);
}

/**
 * Check if a specific (chatId, threadId) pair is currently watching.
 * Callers in General chat with no thread should use isWatchingAny instead.
 */
export function isWatching(chatId: number, threadId: number): boolean {
  return watches.has(watchKey(chatId, threadId));
}

/** True if any topic in this chat has an active watch. */
export function isWatchingAny(chatId: number): boolean {
  const prefix = watchKeyChatPrefix(chatId);
  for (const k of watches.keys()) {
    if (k.startsWith(prefix)) return true;
  }
  return false;
}

/** Return the first active watch whose sessionDir matches `cwd`, or null. */
export function findWatchByDir(cwd: string): WatchState | null {
  for (const [, w] of watches) {
    if (w.sessionDir === cwd) return w;
  }
  return null;
}

/** Return the active watch for a given topic, if any. */
export function getWatch(
  chatId: number,
  threadId: number,
): WatchState | undefined {
  return watches.get(watchKey(chatId, threadId));
}

/** Test seam — register a pre-built WatchState without starting a tailer. */
export function _registerWatchForTests(state: WatchState): void {
  watches.set(watchKey(state.chatId, state.threadId), state);
}

/** Test seam — read back a registered WatchState (or undefined). */
export function _getWatchForTests(
  chatId: number,
  threadId: number,
): WatchState | undefined {
  return watches.get(watchKey(chatId, threadId));
}
