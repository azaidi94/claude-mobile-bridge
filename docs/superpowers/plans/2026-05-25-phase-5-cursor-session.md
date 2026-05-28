# Phase 5 — Cursor as a Session implementation

**Goal:** Unify Cursor and Claude Code under one `Session` interface. Eliminate the `source === "cursor"` branching scattered through handlers, the `cursor-*` sessionId guards, and the parallel sync/reconnect lifecycle.

**Estimated effort:** 2 days.

**Branch:** `refactor/phase-5-cursor-session`

**Dependencies:** Phases 1 (SessionContext) and 2 (message bus).

## Why

The Cursor bridge is currently an island. It:

- Has its own session registry (`addCursorSession`)
- Has its own sync loop (`syncBridges` every 5s)
- Has its own reconnect logic (today's CDP-liveness work)
- Uses its own delivery path (`cdpClient.evaluate` to inject into Composer DOM)
- Identifies sessions with a synthetic ID format (`cursor-<slug>`) that _every_ handler now has to special-case

The result: every code path that handles "a session" has to decide which branch it's in. The `cursor-*` guards we added today in `photo.ts`, `voice.ts`, `document.ts`, `relay-bridge.ts` are exactly this — and there'll be more of them as long as Cursor is a special case.

The right shape: **Cursor is a kind of `Session`. CC is another kind. Both implement the same interface.** Handlers don't branch.

## Target

```ts
// src/sessions/session.ts (new)
export interface Session {
  readonly id: string;
  readonly dir: string;
  readonly source: "cc" | "cursor";
  readonly capabilities: SessionCapabilities;

  send(content: OutboundContent): Promise<SendResult>;
  isAlive(): boolean;
  close(): void;
}

export interface SessionCapabilities {
  text: boolean; // CC: yes, Cursor: yes
  image: boolean; // CC: yes, Cursor: no (Composer doesn't take image attachments via CDP)
  voice: boolean; // Both: depend on transcription-then-text
  document: boolean; // CC: yes, Cursor: no
  askRemote: boolean; // CC: yes, Cursor: no
}

// Implementations:
// - CcRelaySession  (in src/sessions/cc.ts) — wraps the relay client
// - CursorSession   (in src/sessions/cursor.ts) — wraps the CursorBridge
```

Handlers no longer branch on source. They consult capabilities:

```ts
export async function handlePhoto(ctx: Context, sctx: SessionContext) {
  const session = resolveSession(sctx);
  if (!session.capabilities.image) {
    await bus.send({
      chatId: ctx.chat.id,
      threadId: sctx.topicId,
      content: `❌ Photos aren't supported in ${session.source} sessions yet.`,
    });
    return;
  }
  // ... rest of the flow is source-agnostic
}
```

## Scope

### Files that change

| File                                                      | Change                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/sessions/session.ts` (new)                           | The interface + capabilities + base types                                                      |
| `src/sessions/cc.ts` (new)                                | CC-backed `Session` implementation, wraps `relay/client.ts`                                    |
| `src/sessions/cursor.ts` (new)                            | Cursor-backed `Session` implementation, wraps `cursor/bridge.ts`                               |
| `src/sessions/registry.ts` (refactored from `watcher.ts`) | One registry, both kinds                                                                       |
| `src/handlers/*.ts`                                       | Drop `source === "cursor"` checks; consult `session.capabilities` instead                      |
| `src/handlers/relay-bridge.ts`                            | Becomes the CC implementation's `send()` body; not handler-facing any more                     |
| `src/cursor/index.ts`                                     | Lifecycle (sync, reconnect) stays; Cursor `Session` instances get registered alongside CC ones |
| `src/cursor/bridge.ts`                                    | Adapt `inject()` to fit `Session.send()` signature                                             |

### Files that don't change

- `relay/discovery.ts` (still finds CC port files)
- `cursor/cdp-client.ts` (still talks CDP)
- `topics/*` (already source-agnostic except for the `cursor-` placeholder sessionId — phase 1's SessionContext should already mask this)

## Stepwise approach

1. **Define interface + write tests against doubles (~3 hr).** Build the interface in isolation; characterise expected behaviour.
2. **Implement `CcRelaySession` (~3 hr).** Wrap existing `relay/client.ts`. Test parity: existing CC tests still pass when the production code routes through `CcRelaySession`.
3. **Implement `CursorSession` (~3 hr).** Wrap `cursor/bridge.ts`'s inject path. Capabilities: text only.
4. **Migrate handlers (~4 hr).** Replace branching with capability checks. ~5 handler files. The `cursor-*` guards we added today get deleted.
5. **Unify the registry (~2 hr).** One `sessionRegistry` exposes both kinds. `getSession(name)` returns whichever exists.
6. **Cleanup (~1 hr).** Delete `addCursorSession` (folded into `registry.add()`). Delete `cursor-*` sessionId synthetic-prefix logic where no longer needed.

## Acceptance criteria

- Grep for `=== "cursor"` and `startsWith("cursor-")` in `src/handlers/` returns 0 results
- Photo/voice/document handlers check `session.capabilities.image` instead of branching by source
- Cursor and CC sessions both appear in the same `sessionRegistry`
- All scenario tests pass
- Manual: a Cursor topic and a CC topic both work; the rejection message for photos in a Cursor topic still appears (just driven by capability, not source check)

## Risks

- **Existing CC-specific knobs** (`/model`, `/usage`, AskUserQuestion) need to map to capabilities sensibly. Some handlers will need to reject for Cursor source — that's fine, it's centralised behind `session.capabilities.X`.
- **Lifecycle differences.** Cursor sessions live as long as CDP target is alive; CC sessions live as long as relay process is alive. The `Session.isAlive()` semantic needs to handle both.
- **Event sources.** Cursor uses `globalEventBus`; CC uses JSONL tailing. Unifying the inbound event story is a _bigger_ refactor — out of scope here. We keep the inbound paths split, unify only the outbound `send`.

## Out of scope

- Unifying inbound event streams (a Phase 8 if we wanted to keep going)
- Adding new agent types (Codex, Gemini) — but Phase 5 makes that ~1 day of work each
- Web UI session-source UI changes
