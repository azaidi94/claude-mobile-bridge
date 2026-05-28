# Phase 1 — Kill the singleton session 🔑

**Goal:** Eliminate the singleton `session` module and `getActiveSession()` as load-bearing state. Replace with an explicit `SessionContext` resolved at handler entry and passed through every call.

**Estimated effort:** 2 days.

**Branch:** `refactor/phase-1-session-context`

**Dependencies:** Phase 0 must be green.

## Why this is phase 1

This is the single highest-leverage change in the entire refactor. Nearly every multi-session bug we've shipped this month — the photo handler regression, the relay-bridge mis-routing in Cursor topics, the "no desktop session found" false positives, the AUQ binding failures — traces back to handlers reading `session.workingDir`, `session.sessionId`, or `getActiveSession()` and getting back state that belongs to a _different_ topic than the one the user is in.

After phase 1: every handler signature carries the session it acts on. There is no global "current" session.

## Current shape (the problem)

```ts
// src/session.ts — singleton, mutated everywhere
export const session = new Session();
session.sessionId       // last loaded
session.workingDir      // last loaded
session.loadFromRegistry(si)   // mutates
session.sendMessageStreaming(...)

// src/sessions/watcher.ts
let _activeSessionName: string | undefined;
export function getActiveSession() {
  return _activeSessionName ? cache.sessions.get(_activeSessionName) : ...;
}
// bumped by addCursorSession every 5s, by handler-side loads, by /switch, etc.
```

Handlers do:

```ts
const active = getActiveSession();
const relayUp = await isRelayAvailable({
  sessionId: active?.info.id, // may be a Cursor session!
  sessionDir: session.workingDir || active?.info.dir,
});
```

When the user sends a photo in topic A but Cursor just nudged session B, `active` resolves to B. The preflight checks B's relay, fails, replies "No desktop session found" in topic A.

## Target shape

```ts
// src/sessions/context.ts (new)
export interface SessionContext {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly sessionPid?: number;
  readonly source: "cc" | "cursor";
  readonly topicId?: number;
  readonly chatId: number;
}

export function resolveSessionContext(
  ctx: Context,
): SessionContext | undefined {
  // Topic-first: if we're in a session topic, that's the session.
  // No mutation. No fallback to a global "current".
  // Returns undefined when we genuinely don't know (General topic in forum
  // group with no active session, etc.) — caller decides what to do.
}
```

Every handler signature becomes:

```ts
export async function handleText(
  ctx: Context,
  sctx: SessionContext,
): Promise<void>;
```

A thin entrypoint resolves and passes:

```ts
bot.on("message:text", async (ctx) => {
  const sctx = resolveSessionContext(ctx);
  if (!sctx) return replyNoSession(ctx);
  await handleText(ctx, sctx);
});
```

## Scope

### Files that change

| File                            | Change                                                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sessions/context.ts` (new) | Define `SessionContext`, `resolveSessionContext`                                                                                                    |
| `src/session.ts`                | Delete or shrink to just the streaming SDK wrapper (no global state). Rename → `src/streaming/claude-sdk.ts`                                        |
| `src/sessions/watcher.ts`       | Delete `getActiveSession()` and `_activeSessionName`. Keep registry. Cursor `addCursorSession` no longer bumps `lastActivity` to a shared timeline. |
| `src/topics/topic-router.ts`    | `loadTopicSession()` becomes `resolveSessionContext()`. Drop the `session.loadFromRegistry` side effect.                                            |
| `src/handlers/*.ts`             | Every handler takes `SessionContext`. Bot wires it at the entry point. ~17 handler files touched.                                                   |
| `src/handlers/relay-bridge.ts`  | `sendViaRelay(ctx, message, ..., sctx)` — no `getActiveSession()` fallback.                                                                         |
| `src/__tests__/*.test.ts`       | Tests that mock `getActiveSession()` now pass `SessionContext` directly. ~15 test files affected.                                                   |

### Files that don't change

- `topics/topic-store.ts` (persistence is fine)
- `relay/discovery.ts`, `relay/client.ts` (already take selectors, not globals)
- `web/*` (already mostly explicit)
- `cursor/*` (its event-bus integration doesn't depend on session globals)

## Stepwise approach

To keep PRs reviewable and the branch always green:

1. **Add new without removing old (~3 hr).** Introduce `SessionContext`, `resolveSessionContext`, and a `--session-context` feature flag. Bot can run with old or new path. New code paths shadow old.
2. **Migrate handlers one at a time (~6 hr).** `text` → `photo` → `voice` → `document` → `commands/*` → `callback`. Each migration is a single PR-worth of work. Tests stay green after each.
3. **Delete the singleton (~2 hr).** Once all handlers consume `SessionContext`, `session.ts` and `getActiveSession()` are dead code. Delete them. Tests pass.
4. **Tighten `addCursorSession` (~1 hr).** Stop bumping the shared `lastActivity` field; Cursor sessions get their own "alive" tracker.
5. **Sweep through `--session-context` flag (~30 min).** Remove the flag and old code paths.

## Acceptance criteria

- `session.ts` either deleted or reduced to <100 lines of SDK-wrapper code
- `getActiveSession()` removed from the codebase (or replaced with a clearly-bounded function with no caller from handlers)
- Every handler function takes `SessionContext` as a required argument
- The Phase 0 S2 test (photo-to-cc-via-topic with Cursor recently active) is still green
- `bun run test` clean
- Manual smoke: send messages in 2 different topics in fast succession, verify each lands in the right session

## Risks

- **Test churn.** ~15 test files need refactoring. Mitigation: do this incrementally, gated by Phase 0 scenarios.
- **Hidden callers.** `getActiveSession()` may be called from places not currently in handlers. Mitigation: ripgrep audit before the deletion step.
- **Web UI surface.** The web UI's "active session" concept is also user-visible. Need to confirm it's a UI-level pointer (per-tab), not coupled to backend `getActiveSession()`.

## Out of scope

- Topic-manager refactor (Phase 3)
- Cursor's CDP integration (Phase 5)
- Removing the `session.loadFromRegistry` calls that exist purely for SDK warm-up (need a separate decision)
