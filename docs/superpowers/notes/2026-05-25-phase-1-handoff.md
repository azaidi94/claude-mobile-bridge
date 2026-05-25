# Phase 1 — Handoff state (2026-05-25, updated)

Resumes Phase 1 after task 5 landed in two batches. Next session picks up at task 6.

## Branches

```
main
└── refactor/clean-architecture           (237febb — 9 phase plan docs)
    └── refactor/phase-0-characterisation (887f0e8 — 16 scenario tests)
        └── refactor/phase-1-session-context
            ├── 0e27854 — SessionContext type + resolver (additive)
            ├── efcd745 — text.ts migrated  (task 3)
            ├── 4975619 — photo/voice/document migrated (task 4)
            ├── cf27783 — commands.ts migrated (task 5, batch 1)
            └── 8c1d7e3 — callback dispatch migrated (task 5, batch 2)
```

Currently checked out: `refactor/phase-1-session-context`.

## What's shipped

- `src/sessions/context.ts` — `SessionContext` + `resolveSessionContext`
  (now callback-aware: reads thread_id from `ctx.message` OR
  `ctx.callbackQuery?.message`) + `sessionContextFromInfo`
- `src/bot.ts` — all four `message:*` handlers AND every session-aware
  `bot.command(...)` go through a `withSctx` wrapper that resolves once
  and passes the result as the second arg
- Migrated handlers (signature now `(ctx, sctx?)`):
  - text, photo, voice, document
  - `/start` `/respawn` `/stop` `/kill` `/status` `/model` `/pin`
    `/pwd` `/cd` `/ls`
- `src/handlers/commands.ts` introduces `warmSingletonFromSctx(sctx)` —
  one place keeps the streaming SDK singleton aligned with sctx so the
  existing `session.xxx` reads (model, isRunning, lastError…) continue
  to point at the right session until task 7 retires the singleton
- `src/handlers/callback.ts` — picker dispatch (`status_pick:` /
  `model_pick:` / `stop_pick:`) builds sctx via
  `sessionContextFromInfo` from the picked SessionInfo and passes it to
  the handler. `model:` callback resolves sctx at entry and uses it for
  pinned-status sessionName/dir so a model switch fired from topic A
  no longer mis-pins to whichever session the singleton last loaded.
- Test mocks: 4 test files updated to expose `resolveSessionContext` from
  the `../sessions` mock (commands, plan-mode, ask-user-question,
  auto-watch-retry). Phase-0 scenarios still pass.

Behaviour delta vs main: still none — singleton remains warmed inline.
Routing is now explicit; the singleton retires in task 7.

## Test state

- `bun run typecheck` — clean
- `bun run test` — 0 fail (one known flake: `web-tasks-route` event-
  stream test, pre-existing on main, timing-dependent; passes when run
  in isolation)
- Phase 0 S2 (photo-to-cc-via-topic) — still green

## What's NOT done

Tasks 6-9 remain. Plus a few items left out of task 5 by design:

### Left in task 5 on purpose

- `handleRetry` — still reads `session.lastMessage` (singleton-bound).
  Migrate alongside per-session `lastMessage` storage in task 7.
- `handleSwitch` — `getActiveSession()` use is about the v1 global
  pointer, not topic routing. Stays until phase 2 removes the v1 picker.
- Inside `killSession`/`respawnSession` helpers — the
  `getActiveSession()` checks decide whether to also tear down the
  streaming SDK singleton. Move to task 7 with the rest of the
  singleton retirement.
- Callback branches other than the pickers/model — singleton-bound
  state (plan approval, auq, switch:, sess_pick:, sess_resume:) or
  operate on a SessionInfo directly. No useful sctx role yet.

### Remaining phase-1 tasks

6. **Migrate relay-bridge + watch dispatch** (notifications too).
   `sendViaRelay(ctx, message, ..., sctx)` per the plan — drop the
   `getActiveSession()` fallback. Watch dispatch into the right topic
   already uses an explicit session name; just thread sctx through for
   the relay preflight.
7. **Delete singleton `session.ts` + `getActiveSession()`** — needs
   per-session storage for `lastMessage`, `pendingPlanApproval`, and
   the streaming SDK wrapper refactored off the singleton first. This
   is the load-bearing change; budget the most time here.
8. **Stop `addCursorSession` bumping shared `lastActivity`** so
   dir-match in `sendViaRelay` stops mis-routing to recently-touched
   Cursor sessions.
9. **Full test sweep + manual smoke**.

## How to resume — Task 6 (relay-bridge + watch dispatch)

```bash
grep -rn "getActiveSession\|loadTopicSession" \
  src/handlers/relay-bridge.ts src/handlers/watch.ts \
  src/sessions/watcher.ts src/sessions/index.ts
```

### Strategy

`sendViaRelay` is the highest-priority site — it's the source of "no
desktop session found" false positives because it falls back to
`getActiveSession()` when the caller doesn't pass an override. After
task 6 it should:

- Take `sctx?: SessionContext` (already passed `sessionOverride` from
  text.ts; consolidate the two).
- When sctx provided, use sctx.{sessionId, sessionDir, sessionPid}
  directly for `isRelayAvailable` and `client.connect`.
- When sctx undefined (General topic dispatch from a notification),
  keep the existing dir-match logic but no `getActiveSession()`
  fallback — explicit lookup only.

### Don't touch yet

- `session.workingDir` writes inside handlers (defer to task 7).
- The singleton's `lastActivity` bumping (task 8).

## Pitfalls (still relevant)

- **`session.loadFromRegistry(si)` warms the streaming SDK** — don't
  drop the warm-up until task 7. `warmSingletonFromSctx` is the one
  place that does it for the migrated handlers.
- **`session.lastMessage = message;`** in text.ts line ~476 — keep
  until task 7.
- **`session.sessionId = null;`** in `/clear` — same. Ticket cleanup
  for task 7.
- **Phase 0's S2 test** still the strongest guard against photo-routing
  regression. Re-run after every handler migration.
- **`web-tasks-route` SSE test flakes** in the full suite — ignore as
  long as it passes in isolation. Pre-existing.

## Useful command snippets

```bash
# Find remaining getActiveSession callers (excluding sessions/ + tests)
grep -rn "getActiveSession" src --include="*.ts" \
  | grep -v __tests__ | grep -v __mocks__ | grep -v src/sessions/

# Find singleton imports
grep -rln 'from "../session"\|from "./session"' src --include="*.ts" \
  | grep -v __tests__ | grep -v __mocks__

# Re-run scenario tests
bun test src/__tests__/scenarios/

# Full isolated suite (used by `bun run test`)
bun run test
```

## Plan docs

- Overview: `docs/superpowers/plans/2026-05-25-clean-architecture-overview.md`
- Phase 1 detail: `docs/superpowers/plans/2026-05-25-phase-1-session-context.md`
- Phase 0 review: `docs/superpowers/plans/2026-05-25-phase-0-characterisation-tests.md`
