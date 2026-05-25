# Phase 1 — Handoff state (2026-05-25)

This note describes where Phase 1 stopped mid-session so the next agent can
resume cleanly.

## Branches

```
main
└── refactor/clean-architecture           (237febb — 9 phase plan docs)
    └── refactor/phase-0-characterisation (887f0e8 — 16 scenario tests)
        └── refactor/phase-1-session-context (0e27854 — foundation only)
```

Currently checked out: `refactor/phase-1-session-context`.

## What's shipped on this branch

**One commit (`0e27854`):**

- `src/sessions/context.ts` (new) — `SessionContext` interface +
  `resolveSessionContext(ctx)` + `sessionContextFromInfo(si, chatId, topicId?)`
- `src/sessions/index.ts` — barrel export of the above
- `src/__tests__/scenarios/resolve-session-context.test.ts` — 6 tests, green

The change is **additive**. No existing handler calls `resolveSessionContext`
yet. The singleton (`src/session.ts`) and `getActiveSession()` still drive
every handler. Bot behaviour on this branch is identical to `main` + Phase 0.

## What's NOT done

Tasks 3-9 of Phase 1 (see `TaskList`):

3. **Migrate text.ts** to consume `SessionContext` (proof of pattern)
4. **Migrate photo/voice/document** handlers
5. **Migrate commands.ts + callback.ts** (biggest file — 2017 lines)
6. **Migrate relay-bridge + watch dispatch**
7. **Delete singleton `session.ts` + `getActiveSession()`**
8. **Stop `addCursorSession`** bumping shared `lastActivity` timeline
9. **Full test sweep + manual smoke**

## Scope (re-audited)

The plan doc's 2-day estimate was honest but tight. Actual footprint:

- 14 files import from `src/session.ts`
- 30+ call sites of `getActiveSession()` across handlers, watch, commands,
  web routes, notifications, streaming, callback
- `ClaudeSession` class has ~10 mutable fields (sessionId, lastActivity,
  queryStarted, currentTool, lastTool, lastError, lastUsage, lastMessage,
  abortController) + the streaming SDK wrapper

Realistic re-estimate: 3 focused days, ideally split across 2-3 sessions
with PR reviews between.

## How to resume — Task 3 (migrate text.ts)

The pattern, once landed in `text.ts`, will be copy-paste for the others.

### Step 1: change the signature

```diff
- export async function handleText(ctx: Context): Promise<void> {
+ export async function handleText(
+   ctx: Context,
+   sctx: SessionContext | undefined,
+ ): Promise<void> {
```

`sctx` is optional during migration because `bot.ts` will keep calling the
old signature for unmigrated paths. Once all handlers take it, make it
required.

### Step 2: replace the topic-resolution block

`text.ts` lines 90-115 currently inline `isTopicChat` + `isSessionTopic` +
`session.loadFromRegistry` + manual `sessionOverride` construction. Replace:

```ts
// 1.2. Topic context — use the explicit session context the caller
// resolved (Phase 1). Fall back to legacy globals when undefined (private
// chat, General topic, or unbound session topic).
let threadId = sctx?.topicId;
let sessionOverride: SessionOverride | undefined = sctx
  ? {
      sessionId: sctx.sessionId,
      sessionDir: sctx.sessionDir,
      sessionPid: sctx.sessionPid,
    }
  : undefined;
let cursorSessionName: string | undefined =
  sctx?.source === "cursor" ? sctx.sessionName : undefined;
```

Then delete the inline topic-router code and the `session.loadFromRegistry`
side-effect call.

### Step 3: wire the resolver in `bot.ts`

```diff
  bot.on("message:text", async (ctx) => {
-   await handleText(ctx);
+   const sctx = resolveSessionContext(ctx);
+   await handleText(ctx, sctx);
  });
```

### Step 4: replace `getActiveSession()` reads in `text.ts`

Line 483: the fallback when no session is loaded. Use `sctx` directly when
available; the existing code path runs only when `sctx` is undefined.

### Step 5: run Phase 0 tests

```bash
bun run test
```

All 16 scenario tests + the 6 new resolver tests must still pass.

### Step 6: manual smoke

```bash
./restart.sh
```

Then send a TG text message in each of the live topics; verify each lands
in the right CC/Cursor session via the bot log.

### Step 7: commit

```
feat(phase-1): migrate handleText to SessionContext

text.ts's topic resolution + session-override construction is replaced
with the explicit SessionContext from bot.ts. session.loadFromRegistry
side-effect is removed from the text-message hot path.

Other handlers still read the singleton; they'll migrate in subsequent
commits. The singleton itself stays alive until task 7.
```

## Pitfalls

- **`session.lastMessage = message;`** at line 476 — used by `/retry`. When
  the singleton goes away (task 7), this needs a per-session store. For
  now, keep the write — leave the dependency.
- **`session.sessionId = null;`** in the `/clear` branch at line 461 — same
  shape. The clear semantics need rethinking when there's no singleton;
  ticket as a follow-up rather than block Phase 1.
- **`session.loadFromRegistry(si)` warms the streaming SDK** so the next
  `session.sendMessageStreaming` uses the right session. As long as the
  singleton exists, keep the warm-up. Delete the call only after migrating
  off the streaming SDK wrapper (Phase 1 task 7).
- **Phase 0's S2 test** is the strongest guard against regressing the photo
  bug class. It runs at the selector layer, not the handler layer — so
  text.ts migration won't break it, but photo.ts migration in task 4 might.
  Re-run it after every handler migration.

## Useful command snippets

```bash
# Find remaining getActiveSession callers (excluding sessions/ + tests)
grep -rn "getActiveSession" src --include="*.ts" \
  | grep -v __tests__ | grep -v __mocks__ | grep -v src/sessions/

# Find singleton imports
grep -rln 'from "../session"\|from "./session"' src --include="*.ts" \
  | grep -v __tests__ | grep -v __mocks__

# Re-run Phase 0 + Phase 1 scenario tests
bun test src/__tests__/scenarios/

# Full isolated suite
bun run test
```

## Plan docs

- Overview: `docs/superpowers/plans/2026-05-25-clean-architecture-overview.md`
- Phase 1 detail: `docs/superpowers/plans/2026-05-25-phase-1-session-context.md`
- Phase 0 review (what shipped): `docs/superpowers/plans/2026-05-25-phase-0-characterisation-tests.md`
