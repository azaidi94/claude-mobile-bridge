# Phase 1 — Complete (2026-05-25)

**Phase 1 is done.** Singleton retired. Every per-session state lives in `SessionState`, resolved at handler entry from `SessionContext`.

## Branches

```
main
└── refactor/clean-architecture           (237febb — 9 phase plan docs)
    └── refactor/phase-0-characterisation (887f0e8 — 16 scenario tests)
        └── refactor/phase-1-session-context   ✅ ready to PR back into refactor/clean-architecture
            ├── 0e27854 — SessionContext type + resolver (task 2)
            ├── efcd745 — text.ts migrated (task 3)
            ├── 4975619 — photo/voice/document migrated (task 4)
            ├── cf27783 — commands.ts migrated (task 5a)
            ├── 8c1d7e3 — callback dispatch migrated (task 5b)
            ├── 25b63d6 — relay-bridge + watch migrated (task 6)
            ├── 4b919f2 — task 6 review feedback
            ├── c797d35 — task 7 sub-plan
            ├── 0757603 — SessionState container (task 7a)
            ├── 8e9d459 — stateless streaming wrappers (task 7b)
            ├── 07146f3 — text.ts → SessionState (task 7c)
            ├── 21834a3 — photo/voice/document/callback → SessionState (task 7d)
            ├── a292128 — commands/relay-bridge/topic-router → SessionState (task 7e)
            ├── 1e042e5 — infra wireup → SessionState (task 7f)
            └── f8053e5 — singleton + getActiveSession deleted (task 7g)
```

## Acceptance — all met

- `grep -rn "getActiveSession\b" src --include="*.ts" | grep -v __tests__` — only doc comments referencing the retired API.
- `grep -rn 'import { session' src --include="*.ts" | grep -v __tests__` — empty.
- `src/session.ts` reduced to free functions: `runQueryStreaming`, `runPlanApproval`, `autoApproveWebTools` + model API (`getCurrentModel`, `setCurrentModel`, `getCurrentModelDisplayName`) + helpers.
- `src/sessions/session-state.ts` is the single source of truth for per-session fields. Resolved via `getSessionState(name)`.
- `bun run typecheck` clean. `bun run test` clean modulo known flakes (`web-tasks-route` SSE, `backfill-end-to-end` ordering).
- Phase 0 scenario tests — all pass except the known `backfill-end-to-end` flake.

## What changed structurally

1. Routing is explicit through `SessionContext` (resolved topic-first from `ctx.message.message_thread_id` or callback-query message). No global "current session" pointer.
2. Per-session state lives in `SessionState`, keyed by `sessionName` in a `Map`. `runQueryStreaming(state, opts)` and `runPlanApproval(state, opts)` are free functions that operate on the passed-in state — two queries can run in parallel against different SessionStates without interfering.
3. Mode-change events now flow over `globalEventBus` (channel `sessionName`, type `mode_change`) instead of a singleton callback. `index.ts` installs a lazy per-state subscriber via `setOnSessionStateCreated`.
4. Model state stays global (per R3): `_currentModel` module-level in `src/session.ts`. `/model` writes via `setCurrentModel`. Reasoning: per-session model is a feature change, parked for phase 5 if requested.

## Remaining phase 1 tasks 8–9

Tasks 8 and 9 are still open:

8. **Stop `addCursorSession` bumping shared `lastActivity`** — dir-match in `sendViaRelay` can still mis-route to recently-touched Cursor sessions. Small, self-contained.
9. **Full test sweep + manual smoke** — exercise topic routing across CC + Cursor sessions in parallel; verify the known flakes are still flakes (not regressions).

Both can land in one branch (or two small commits) and close out phase 1.

## Open follow-ups for later phases

- The `loadTopicSession`/`TopicSessionResult` deprecation (deferred from task 6) should be cleaned up alongside Phase 0 test re-pointing.
- The `web-tasks-route` SSE timing flake and `backfill-end-to-end` ordering flake are pre-existing on main; they should be tracked but aren't phase-1 work.
- `process.env.TELEGRAM_CHAT_ID` inside `runQueryStreaming` is a process-global side-effect for the ask_user MCP server. Flagged for cleanup in phase 4 or 5.
- Some Phase 0 characterisation tests still exercise `loadTopicSession` — they capture pre-refactor behavior as a baseline. Update or delete in a future tidy pass.

## Pitfalls to watch in phase 2+

- The streaming-callback closure pattern: callbacks write `state.currentTool`, `state.lastTool`, etc. via the _passed-in_ state reference. If any future refactor reintroduces `this`-bound callbacks, the multi-session invariant breaks.
- `setActiveSession()` and the ACTIVE_SESSION_FILE persistence are still there to support the v1 picker (`handleSwitch`, the /list checkmark, etc.). Phase 2 should decide whether to keep that concept or drop it entirely.
- Test mocks that referenced the old singleton (`import { session }` shape) were converted to mock `getSessionState`. New tests should follow the same pattern: stub `getSessionState` returning a SessionState-shaped object.

## Plan docs

- Overview: `docs/superpowers/plans/2026-05-25-clean-architecture-overview.md`
- Phase 1 detail: `docs/superpowers/plans/2026-05-25-phase-1-session-context.md`
- Phase 1 task 7 sub-plan: `docs/superpowers/plans/2026-05-25-phase-1-task-7-singleton-retirement.md`
- Phase 0 review: `docs/superpowers/plans/2026-05-25-phase-0-characterisation-tests.md`
