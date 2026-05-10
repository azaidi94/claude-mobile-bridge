# Session Event Bus Design

**Date:** 2026-05-06  
**Status:** Approved

## Problem

The system has three separate point-to-point message delivery paths:

- Telegram ↔ relay TCP ↔ Claude ↔ relay TCP ↔ Telegram
- Web UI ↔ relay TCP ↔ Claude ↔ relay TCP ↔ Web UI SSE
- JSONL tailer → globalEventBus → Web UI SSE

User messages are never published to the bus, and relay replies bypass the bus entirely. As a result:

- Messages sent from the web UI don't appear in Telegram
- Messages sent from Telegram don't appear in the web UI
- Terminal (TUI) input is visible in the JSONL tailer output but not attributed to a source in the web UI
- Adding a new consumer (e.g. Cursor bridge) requires wiring a new point-to-point path

## Goal

Make `globalEventBus` the single delivery mechanism for all session activity. Every message — regardless of source — is published to the bus. Every consumer subscribes to the bus.

## Architecture

### Bus Role

The relay TCP connection is retained but its role narrows to **injection only**: sending messages to Claude. All delivery (returning content to consumers) flows exclusively through the bus.

```
Any source → bus (user_message) → Claude (via relay TCP, unchanged)
Claude     → JSONL tailer → bus (text, tool, thinking, done) → All consumers
```

### Event Schema

Add `user_message` to `SseEvent` in `src/web/sse.ts`:

```typescript
{
  type: "user_message";
  content: string;
  source: "telegram" | "web" | "terminal" | "cursor";
}
```

All existing event types (`text`, `tool`, `thinking`, `done`, `tool_result`, etc.) are unchanged. The bus key remains session name (stable across UUID drift).

### Publishers

| Source          | Where                    | What                                                                             |
| --------------- | ------------------------ | -------------------------------------------------------------------------------- |
| Telegram        | `handlers/text.ts`       | `{type:"user_message", source:"telegram", content: text}` after relay send       |
| Web UI          | `web/routes/sessions.ts` | `{type:"user_message", source:"web", content: body.text}` before `sendWebRelay`  |
| JSONL tailer    | `handlers/watch.ts`      | All Claude output — no change needed                                             |
| Terminal input  | JSONL tailer             | Already captured as user turns in JSONL, flows through tailer path automatically |
| Cursor (future) | `cursor/bridge.ts`       | Same pattern as Telegram/web                                                     |

### Subscribers

**Web UI SSE** (`web/routes/sessions.ts`)  
Already subscribes to the bus. Frontend updated to render `user_message` events as attributed user turns (e.g. "› Web:" prefix).

**Telegram** (`handlers/watch.ts`)  
New subscription added in `startAutoWatch`. Forwards user messages from non-Telegram sources to the Telegram topic with source attribution:

```typescript
bus.subscribe(sessionName, (evt) => {
  if (evt.type === "user_message" && evt.source !== "telegram") {
    const prefix = evt.source === "web" ? "🌐 Web" : "🖥 Terminal";
    botApi.sendMessage(chatId, `${prefix}: ${evt.content}`, {
      message_thread_id: threadId,
    });
  }
});
```

The existing tailer→`handleTailEvent`→Telegram path for assistant messages is **not changed**. Only user message cross-posting is new.

## Code Changes

Five small touchpoints — all additive, nothing removed:

1. **`src/web/sse.ts`** — add `user_message` variant to `SseEvent` union with `source` field
2. **`src/handlers/text.ts`** — emit `user_message` to bus after relay send
3. **`src/web/routes/sessions.ts`** — emit `user_message` to bus before `sendWebRelay`
4. **`src/handlers/watch.ts`** — add `setupCrossPostSubscription` helper called from `startAutoWatch`; subscribe to bus and forward non-Telegram user messages to Telegram topic
5. **Frontend** (`src/web/`) — handle `user_message` event type in the chat renderer; display with source badge

## Non-Goals

- Changing how assistant messages reach Telegram (tailer path stays)
- Removing the relay TCP connection (still needed for injection)
- Full event sourcing / persistence of the bus (bus is still in-memory, ephemeral)

## Relation to Cursor Integration

The Cursor bridge (planned, Option A: CDP-based) is a publisher and subscriber on the same bus. No special wiring needed — it publishes `{source:"cursor"}` user messages and its Claude output flows through the same tailer path. The bus architecture is the foundation that makes multi-source sessions work cleanly.
