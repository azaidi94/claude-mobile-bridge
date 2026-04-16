# Multi-Topic Concurrent Watches — Design

Date: 2026-04-16
Status: Approved, awaiting implementation plan

## Problem

The Telegram bot can currently watch only one Claude Code session at a time per chat. The `watches` map in `src/handlers/watch.ts:87` is keyed by `chatId` alone, but Telegram topics share a single chatId across all threads in a group. As a result:

- Starting a watch in topic B silently drops the watch running in topic A (`startAutoWatch` at `watch.ts:286-287`, `startWatchingSession` at `watch.ts:482-483`).
- Killing a session in any topic stops whichever single watch is active for the chat, even if that watch is for an unrelated session in another topic (`killSession` at `src/handlers/commands.ts:763`).

Reproduction: watch session X in topic A; kill and respawn session Y in topic B; topic A's stream goes silent.

## Goal

Support one active watch per topic, concurrent across all topics in a chat. Each topic independently tails its own session's JSONL and relays output to its own thread.

## Non-goals

- Fixing the global `ClaudeSession` singleton mutation in topic routing (`loadTopicSession` at `src/topics/topic-router.ts:57-68`). Tracked as follow-up tech debt.
- Watching in the General chat. General is commands-only going forward; topics are the sole locus of watching.
- Enforcing a cap on concurrent watches. Natural cap is the number of active topics in the chat.

## Design

### Data model

```ts
// src/handlers/watch.ts
type WatchKey = `${number}:${number}`; // "chatId:threadId"
const watches = new Map<WatchKey, WatchState>();
const typingState = new Map<
  WatchKey,
  { running: boolean; timeout: Timer | null }
>();

function watchKey(chatId: number, threadId: number): WatchKey {
  return `${chatId}:${threadId}`;
}
```

- `WatchState.threadId` becomes required (not optional). Set at construction.
- `typingState` keys on the same composite — per-topic typing indicators are independent; Telegram supports per-thread typing via `message_thread_id`.

### Helper API

```ts
isWatching(chatId, threadId): boolean                             // was (chatId)
isWatchingAny(chatId): boolean                                    // NEW — General-chat picker callers
stopWatching(chatId, threadId, botApi?, reason?): WatchState|undefined
stopWatchByDir(sessionDir, botApi?, reason?): WatchState|undefined // NEW — kill path
startWatchingSession(botApi, chatId, threadId, name, reason?)     // threadId now required
startAutoWatch(botApi, chatId, threadId, name)                    // threadId now required
sendWatchRelay(chatId, threadId, username, text, …)               // threadId now required
// setWatchThreadId — DELETED (threadId set at construction)
```

### Lifecycle

- **Spawn** (`commands.ts:624`): threads `threadId` into `startWatchingSession` up front — drop the reactive `setWatchThreadId` follow-up at `commands.ts:640`.
- **Auto-watch on discovery/reconcile** (`src/index.ts:121, :137`): already passes `topicId`. The existing-watch guard in `startAutoWatch` (`watch.ts:286-287`) scopes to the composite key, so concurrent topics coexist.
- **/watch in a topic** (`handleWatch` at `watch.ts:382`): idempotent. If a watch already exists for this `(chatId, threadId)`, reply "already watching". No cross-topic clobber.
- **/unwatch in a topic** (`watch.ts:709`): stops only this topic's watch.
- **Kill** (`commands.ts:763`): swap `stopWatching(chatId, botApi, "kill")` for `stopWatchByDir(sessionInfo.dir, botApi, "kill")`. Topic deletion (`_topicManager.deleteTopic`) is unchanged — kill still tears down watch + relay + pid + cache entry + topic.
- **Session offline** (`notifySessionOffline` at `watch.ts:239-271`): already iterates matching by `sessionDir`. Structurally ready; no logic change.
- **Re-spawn into an existing topic**: the prior watch was cleared on kill, so the new watch registers cleanly under the same key.

### Call-site updates

| File                                 | Change                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `src/handlers/callback.ts:170`       | `isWatching(chatId)` → `isWatchingAny(chatId)` (picker has no thread)  |
| `src/handlers/relay-bridge.ts:37-46` | Read `threadId` from ctx, pass to `isWatching` / `sendWatchRelay`      |
| `src/handlers/text.ts:97-98`         | Drop `setWatchThreadId` call (unnecessary)                             |
| `src/handlers/text.ts:342`           | Pass `threadId` to `sendWatchRelay`                                    |
| `src/handlers/commands.ts:624`       | Pass `threadId` into `startWatchingSession`                            |
| `src/handlers/commands.ts:640`       | Drop `setWatchThreadId` call                                           |
| `src/handlers/commands.ts:763`       | `stopWatching(chatId, ...)` → `stopWatchByDir(sessionInfo.dir, ...)`   |
| `src/handlers/watch.ts`              | Remove `setWatchThreadId` export + dead code                           |
| `src/index.ts:121, :137`             | Already passes topicId; confirm threadId is passed as a positional arg |

General-chat `handleWatch` rejects with: "Watching is per-topic — spawn a session to get a topic."

### Edge cases

1. `notifySessionOffline` finds no matching watch — existing silent no-op, unchanged.
2. Two sessions sharing a dir — `getWatchByDir` returns first match; not a regression (topics are per-session so this shouldn't occur).
3. `/watch` when already watching — reply "already watching", no clobber.
4. Kill when no watch exists for the dir — `stopWatchByDir` returns `undefined`; kill flow continues (relay disconnect, pid kill, topic delete).
5. Topic deleted out-of-band in Telegram UI — subsequent `sendMessage` with stale `threadId` fails; existing `.catch(() => {})` swallows. Acceptable.
6. `idCheckInterval` leaks — each watch's timer is owned by its own state and cleared in `cleanupWatch`. Already per-watch.

### Tests

New tests in `src/__tests__/watch.test.ts`:

1. `isWatching(chatId, threadId)` is false pre-registration, true after `startAutoWatch`, false for a different `threadId` under the same `chatId` (core multi-topic guarantee).
2. `isWatchingAny(chatId)` returns true if any topic in the chat has an active watch.
3. `stopWatching(chatId, threadId)` only removes the target entry; other `(chatId, otherThreadId)` watches survive.
4. `stopWatchByDir(sessionDir)` removes the entry whose state matches by `sessionDir`; other watches survive.
5. `startAutoWatch` / `startWatchingSession` on an existing `(chatId, threadId)` does not clobber — returns "already watching" behavior.

New test in `src/__tests__/commands.test.ts`:

6. Two auto-watches on different `threadId`s; calling `killSession` for one dir stops only the matching watch's tailer; the other's tailer remains active.

A small `_resetWatchesForTests()` export is added following the existing `_reloadForTests` pattern in `src/settings.ts`.

Manual verification per `CLAUDE.md`: `bun run dev`, spawn two sessions in different directories, confirm both topics stream concurrently, kill one, confirm the other still streams.

## Risks

- **Call-site churn**: 13 direct `watches.*` sites + ~6 external callers. Mitigation: the refactor is mechanical and localized; tests cover the new invariants.
- **Global singleton drift** (`session.loadFromRegistry` in `loadTopicSession`) is unchanged by this refactor but becomes more visible under concurrent topic streaming. Not addressed here; follow-up item.

## Open questions

None — all clarifications resolved in brainstorming.
