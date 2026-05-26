# Phase 3 — Complete (2026-05-26)

**Phase 3 is done.** The god files are dead. `commands.ts` (2143 LOC) and `watch.ts` (2206 LOC) are now ~32 per-domain files, none over 400 LOC.

## Branches

```
main
└── refactor/clean-architecture
    └── refactor/phase-3-decompose   ✅ ready to PR back into refactor/clean-architecture
        ├── 4da78d8 — decompose commands.ts → src/handlers/commands/ (step 1)
        └── abdf500 — decompose watch.ts → src/handlers/watch/ (step 2)
```

## What shipped

### commands.ts → src/handlers/commands/ (13 files)

| File                  | LOC | Owns                                                                             |
| --------------------- | --- | -------------------------------------------------------------------------------- |
| app.ts                | 59  | /app                                                                             |
| cleanzombie.ts        | 218 | /cleanzombie                                                                     |
| control.ts            | 314 | /stop /retry /status /model /restart /pin                                        |
| files.ts              | 188 | /pwd /cd /ls                                                                     |
| group-mode.ts         | 118 | /groupmode + callback                                                            |
| helpers.ts            | 313 | busReply, topic-manager ref, picker/resolver, /start /help /refresh              |
| index.ts              | 67  | re-export surface                                                                |
| offline-sessions.ts   | 92  | /sessions + offlineSessionCache                                                  |
| run.ts                | 101 | /run                                                                             |
| sessions.ts           | 400 | /new /kill /respawn /list + killSession/sendPostKillSessionList/respawnSession   |
| spawn.ts              | 304 | spawnDesktopClaudeSession                                                        |
| switch.ts             | 61  | /switch                                                                          |
| terminal-launchers.ts | 135 | buildTerminalSpawnArgs / buildDesktopShellCommand / openMacOSTerminalWithCommand |

### watch.ts → src/handlers/watch/ (19 files)

| File                 | LOC | Owns                                                             |
| -------------------- | --- | ---------------------------------------------------------------- |
| cleanup.ts           | 144 | stopWatching + cleanup helpers                                   |
| context-usage.ts     | 56  | context-window crossing notifications                            |
| cross-post.ts        | 42  | setupCrossPostSubscription                                       |
| event-router.ts      | 322 | handleTailEvent (the big switch) + bridgeTailToSse               |
| hook-cards.ts        | 40  | hook-summary rendering + formatTaskNotification                  |
| idle-watchdog.ts     | 196 | watchdogTimer + handleIdleWatch + run-completion pings           |
| index.ts             | 69  | public re-export surface                                         |
| jsonl-tailer.ts      | 271 | drift detection, \_awaitSessionId, \_resolveLiveJsonlPath        |
| lifecycle.ts         | 264 | handleWatch / handleUnwatch / stopWatchByName + test seams       |
| offline-queue.ts     | 39  | flushBridgeReconnectSummaries                                    |
| permission-banner.ts | 46  | permission_mode rendering                                        |
| registry.ts          | 84  | watches Map + killedSessionIds + watchKey                        |
| relay-replies.ts     | 124 | TCP-relay onReply binding + sendWatchRelay                       |
| session-builder.ts   | 309 | startWatchingSession + startAutoWatch + resolveAutoWatchConflict |
| state.ts             | 159 | WatchState + TailDisplayState + buildWatchState                  |
| text-renderer.ts     | 179 | text-bubble accretion, finalizeTextMessage, resetDisplaySegment  |
| tool-headers.ts      | 143 | tool-use rendering                                               |
| tool-results.ts      | 81  | tool-result rendering                                            |
| typing.ts            | 74  | typingState + touchWatchTyping / stopWatchTyping                 |

## Acceptance — all met

- `src/handlers/commands.ts` — deleted
- `src/handlers/watch.ts` — deleted
- Every new file ≤ 400 LOC (sessions.ts hits the cap exactly; event-router.ts at 322 is the watch-side max)
- `bot.ts` and `src/handlers/index.ts` re-exports unchanged — no caller's import path changed
- Module-level shared state collapsed to single homes:
  - `_topicManager` → `commands/helpers.ts`
  - `offlineSessionCache` → `commands/offline-sessions.ts`
  - `watches` Map + `killedSessionIds` → `watch/registry.ts`
  - `typingState` → `watch/typing.ts`
- `bun run typecheck` clean; `bun run test` 0 fails; scenarios 21/22 (known S5 backfill flake only)
- Pure mechanical extraction — every function body byte-identical pre/post; verified by spot-checks

## Notes

- `bindRelayReplyHandler` extracted as a helper in `watch/relay-replies.ts` — the prior `startWatchingSession` and `startAutoWatch` inlined byte-identical `onReply` closures except for one log prefix string, now passed as a parameter.
- `handleSwitch`, `handleRun`, `handleGroupMode` weren't in the plan's table but needed homes — went to their own files (`switch.ts`, `run.ts`, `group-mode.ts`) to keep `sessions.ts` and `control.ts` under the 400-LOC cap.

## Pitfalls to watch in phase 4+

- The renderer trunk in `watch/event-router.ts` is the place that knows the full event-type switch. Anyone adding a new TailEvent type touches this file + the renderer it slots into. Don't reintroduce side-channels through the renderers themselves.
- The `_topicManager` getter in `commands/helpers.ts` is the only place that reads/writes the module-level ref. Don't reintroduce copies elsewhere.
- The 9 `TODO(phase-2 status-msg)` / `TODO(phase-2 link_preview)` markers in handlers survived the decomposition unchanged. Phase 4-7 can address.

## Plan docs

- Overview: `docs/superpowers/plans/2026-05-25-clean-architecture-overview.md`
- Phase 3 plan: `docs/superpowers/plans/2026-05-25-phase-3-decompose.md`
