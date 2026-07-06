# /cursor — selective subscription

**Date:** 2026-06-19
**Status:** approved

## Problem

Today `/cursor on` auto-attaches to _every_ Cursor window and cross-posts all
of them to Telegram; `/cursor off` tears the whole bridge down. The user wants
`/cursor` to instead behave like `/list` — show the live Cursor sessions and
let them pick **one** to forward — and keep `off` as a full unwatch.

## Behaviour

`/cursor` (and `/cursor on`):

- Start the bridge if it isn't running, refresh CDP targets once, then render a
  `/list`-style list of **cursor-only** sessions (`SessionInfo.source === "cursor"`).
- One inline button per session (`cursorsub:<name>`); the subscribed one is
  marked ✅. A deep-link button (`t.me/c/<chat>/<topic>`) and an **Off** button
  (`cursor:off`) sit below.
- Empty list (bridge just started, windows not attached yet) → a "scanning,
  re-run /cursor" hint.

Tapping a session (`cursorsub:<name>`):

- Becomes the **sole** subscription — the previous one is unwired. Forwarding of
  that session's Cursor-AI replies to its TG topic begins; choice persists to
  `settings.json` (`cursorSubscribedSession`).
- "Focus" = post a confirmation message into that session's topic (bumps it to
  the top of the forum) and refresh the list message's ✅.

`/cursor off` (arg or button):

- Clear `cursorSubscribedSession`, delete all `cursor-*` topics, stop the bridge
  (existing teardown). Nothing forwards until `/cursor` is run again and a
  session is picked.

## Design

Decouple **attach** from **forward**. The bridge still attaches to all Cursor
windows (needed so they're listable/injectable and topics exist), but
`wireCrossPost` only runs for the session equal to `subscribedSession`.

**`cursor/index.ts`** — new module state `subscribedSession: string | null` and
`running: boolean`. New exports:

- `setCursorSubscription(name | null)` — set the single subscription; unwire any
  other cross-post; wire the new one if its bridge is attached.
- `getCursorSubscription()`, `isCursorBridgeRunning()`.
- `refreshCursorTargets()` — await one CDP sync pass (in-flight-guarded) so the
  command can populate the list immediately after starting the bridge.
- `attachBridge` gates `wireCrossPost` on `finalName === subscribedSession`.
- `startCursorBridge` is idempotent (guards on `running`); `stopCursorBridge`
  clears `subscribedSession`.

**`settings.ts`** — add `cursorSubscribedSession?: string` + sanitize +
`getCursorSubscribedSession()`.

**`handlers/commands/cursor-bridge.ts`** — rewrite render to the list;
`handleCursorSubscribe(ctx, name)` for the new callback; keep
`handleCursorBridgeCallback` for `off`.

**`handlers/callback.ts`** — route `cursorsub:` (before the `cursor:` branch is
fine; prefixes don't overlap).

**`index.ts`** — after `startCursorBridge`, restore `setCursorSubscription(
getCursorSubscribedSession())` so a persisted choice re-wires once its window
attaches.

## Testing

Unit: `setCursorSubscription` wiring/unwiring; `matchWorkspaceDir` unaffected;
list render filters to cursor source; subscribe persists and bumps topic.
Update `commands.test.ts` registration expectations. `bun run typecheck` + `bun
run test` green.
