# Phase 1 — Handoff state (2026-05-25, updated)

Resumes Phase 1 after tasks 3 and 4 landed. Next session picks up at task 5.

## Branches

```
main
└── refactor/clean-architecture           (237febb — 9 phase plan docs)
    └── refactor/phase-0-characterisation (887f0e8 — 16 scenario tests)
        └── refactor/phase-1-session-context
            ├── 0e27854 — SessionContext type + resolver (additive)
            ├── efcd745 — text.ts migrated  (task 3)
            └── 4975619 — photo/voice/document migrated (task 4)
```

Currently checked out: `refactor/phase-1-session-context`.

## What's shipped

- `src/sessions/context.ts` — `SessionContext` + `resolveSessionContext` +
  `sessionContextFromInfo`
- `src/bot.ts` — all four `message:*` handlers wired through
  `resolveSessionContext` and pass `sctx?: SessionContext`
- `src/handlers/text.ts` — uses `sctx`, drops inline isTopicChat/isSessionTopic
- `src/handlers/photo.ts`, `voice.ts`, `document.ts` — same, plus cursor
  rejection now keys off `sctx.source === "cursor"` (not the id prefix)
- `src/__tests__/smoke.test.ts` — mocks `resolveSessionContext` so the
  bot.ts smoke importer doesn't blow up

Behaviour delta vs main: none — `session.loadFromRegistry` is still called
inline by each handler as a warm-up for the streaming SDK singleton. The
data flow into the singleton is unchanged; only the _path_ into the handler
is now explicit. The singleton retires in task 7.

## Test state

- `bun run typecheck` — clean
- `bun run test` (= test:isolated) — 0 fail
- `bun test src/__tests__/scenarios/` (single-process) — S5 fails as a test-
  ordering flake; passes in isolation. Pre-existing on the Phase 0 commit
  too. Not blocking Phase 1.

## What's NOT done

Tasks 5-9:

5. **Migrate commands.ts + callback.ts** — biggest file (2017 lines).
   Trickier than the message handlers because of:
   - `showSessionPicker(ctx, action)` in General context
   - the callback router (`bot.on("callback_query:data", handleCallback)`)
     — callback queries don't carry `message_thread_id` the same way; check
     `getThreadIdFromCallback`
   - `/clear`, `/retry`, `/list`, `/switch` semantics that read the
     singleton's `lastMessage` and `pendingPlanApproval`
6. **Migrate relay-bridge + watch dispatch** (notifications too)
7. **Delete singleton `session.ts` + `getActiveSession()`** — needs the
   streaming SDK wrapper refactored off the singleton first
8. **Stop `addCursorSession` bumping shared `lastActivity`** so dir-match
   in `sendViaRelay` stops mis-routing to recently-touched Cursor sessions
9. **Full test sweep + manual smoke**

## How to resume — Task 5 (commands.ts + callback.ts)

Bigger surface, same playbook. Suggest sub-stepping it as you go:

### 5a. Audit + plan

```bash
grep -n "getActiveSession\|loadTopicSession\|isSessionTopic" \
  src/handlers/commands.ts src/handlers/callback.ts | wc -l
```

Then read the file top-to-bottom and list every command/branch that needs
sctx. Many commands (`/list`, `/help`, `/settings`) are session-agnostic
and won't need it.

### 5b. Migrate per-command

The text.ts pattern (commit `efcd745`) is the template:

```ts
export async function handleX(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> { ... }
```

Then in `bot.ts`:

```diff
- bot.command("x", handleX);
+ bot.command("x", async (ctx) => {
+   await handleX(ctx, resolveSessionContext(ctx));
+ });
```

For callback queries, derive sctx at the dispatch site too. Callbacks
arrive without `message_thread_id` on the message — you may need to look
up the topic via the callback's source message.

### 5c. Per-batch verify

```bash
bun run typecheck && bun run test
```

Commit per logical batch (e.g. session-affecting commands, then
session-agnostic ones, then callback router) instead of one giant commit.

### 5d. Don't migrate yet:

- `session.lastMessage`, `session.pendingPlanApproval`,
  `session.sessionId = null` — these are singleton-bound. Move the per-
  session storage in task 7. For now, keep the singleton writes inline
  exactly as today.

## Pitfalls (still relevant)

- **`session.loadFromRegistry(si)` warms the streaming SDK** — don't drop
  the warm-up until task 7.
- **`session.lastMessage = message;`** in text.ts line ~476 — keep until
  task 7 introduces a per-session store.
- **`session.sessionId = null;`** in `/clear` — same. Ticket cleanup for
  task 7.
- **Phase 0's S2 test** still the strongest guard against photo-routing
  regression. Re-run after every handler migration.

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
