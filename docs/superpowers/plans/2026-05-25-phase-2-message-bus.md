# Phase 2 — Single outbound message bus

**Goal:** All messages sent to Telegram flow through one bus. No more direct `ctx.api.sendMessage` scattered across handlers, watch, cursor-bridge, relay-bridge. Unified parse-mode resolution, chunking, retry, dedup, and observability.

**Estimated effort:** 2 days.

**Branch:** `refactor/phase-2-message-bus`

**Dependencies:** Phase 1 complete.

## Why

There are roughly five overlapping paths to Telegram today:

1. Direct: `ctx.api.sendMessage(...)` and `ctx.reply(...)` — ~20 sites in `handlers/`.
2. Watch path: `sendWatchRelay()` for replies coming from the JSONL tailer.
3. Relay-bridge path: `sendViaRelay` → MCP relay → desktop's `reply` tool back over TCP → `sendTextReply`.
4. Cursor bridge cross-post: `wireCrossPost` subscribes to `globalEventBus` and calls `fwd.api.sendMessage`.
5. Direct status updates: `topic-manager`, `bridge-health`, `notifications` each have their own sends.

Each path:

- Computes its own parse_mode (HTML vs none vs Markdown — recently bug-fixed)
- Implements its own chunking (some don't, hit 4096 silently)
- Picks its own retry strategy (or doesn't retry)
- Logs with different schemas (or doesn't log)
- Decides differently when to suppress (or doesn't suppress)

The "dual-path send" bug class — where a reply is sent twice or zero times because two paths both think they own it — is a direct consequence. We've shipped fixes for this multiple times.

## Target

```ts
// src/messaging/bus.ts (new)
export interface OutboundMessage {
  chatId: number;
  threadId?: number;
  content: string;
  format?: "auto" | "html" | "markdown" | "plain";
  // Idempotency key — bus drops a duplicate within a TTL window.
  // Use messageId-derived keys (e.g. "reply:<opId>", "tool:<toolUseId>")
  // for streams where the bus needs to dedup mid-flight.
  dedupKey?: string;
  // Optional reply context. Bus translates to TG's reply_parameters.
  replyTo?: { messageId: number };
  // Optional attachment (path on disk).
  attachment?: { kind: "photo" | "document" | "voice"; path: string };
}

export interface MessageBus {
  send(
    msg: OutboundMessage,
  ): Promise<
    | { messageId: number }
    | { dropped: "dedup" | "ratelimit" | "error"; reason?: string }
  >;
  edit(messageId: number, msg: OutboundMessage): Promise<void>;
}
```

The bus implementation owns:

- **Format resolution.** `auto` → look at content; HTML if it has Telegram-allowed tags (we have `looksLikeTelegramHtml` already), otherwise markdown.
- **Chunking.** Content > `TELEGRAM_SAFE_LIMIT` splits at paragraph/line boundaries.
- **Plain fallback.** If TG rejects with parse_mode HTML, retry without parse_mode.
- **Rate limiting per chatId+threadId.** ~30/min, smooth bursts.
- **Dedup TTL cache.** 60s window on dedupKey.
- **Logging.** Single schema: `bus.send opId=… chatId=… threadId=… kind=… durationMs=… result=ok|drop`.

## Scope

### Files that change

| File                            | Change                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/messaging/bus.ts` (new)    | The bus interface + production implementation                                                  |
| `src/messaging/format.ts` (new) | Move parse-mode resolution out of `relay/display.ts`                                           |
| `src/relay/display.ts`          | `sendTextReply`, `sendHtmlWithPlainFallback` are deleted; their callers now go through the bus |
| `src/handlers/*.ts`             | Replace `ctx.reply(...)` and `ctx.api.sendMessage(...)` with `bus.send(...)`. ~20 call sites.  |
| `src/handlers/watch.ts`         | Watch-path messages route through the bus                                                      |
| `src/cursor/index.ts`           | `wireCrossPost`'s sendMessage → `bus.send`                                                     |
| `src/topics/topic-manager.ts`   | Status pings via bus                                                                           |
| `src/sessions/notifications.ts` | Notification sends via bus                                                                     |
| `src/bridge-health.ts`          | Health pings via bus                                                                           |

### Files that don't change

- `relay/client.ts` (TCP relay protocol unchanged)
- `formatting.ts` (already a pure module; just consumed by the bus)
- `mcp/channel-relay/server.ts` (the MCP server is the _other_ end of the relay; not a TG sender)

## Stepwise approach

1. **Build the bus + 100% unit-test it (~4 hr).** Test format resolution, chunking, dedup, retry, rate-limit independently.
2. **Wire it as a shadow path (~2 hr).** Introduce `MessageBus.shadowSend()` that the real handlers call alongside `ctx.api`. Compare outputs in dev; assert behaviour matches.
3. **Migrate handlers (~4 hr).** Replace `ctx.reply` / `ctx.api.sendMessage` one at a time. Tests stay green.
4. **Migrate watch.ts (~3 hr).** The most complex case — it streams chunks and edits messages. Bus needs `edit()` too.
5. **Migrate cursor-bridge (~1 hr).** Simple replacement.
6. **Delete `relay/display.ts`'s sendTextReply etc (~1 hr).** Now dead.

## Acceptance criteria

- Grep for `ctx.api.sendMessage` and `ctx.reply` in `src/handlers/` returns 0 results
- `relay/display.ts` deleted (or reduced to a thin chunking helper used internally by the bus)
- All scenario tests still green
- Manual: send a long message that needs chunking, verify chunks land in order in TG
- Manual: trigger a rate limit (rapid messages), verify bus delays without dropping

## Risks

- **Streaming edit-message scenarios** (watch.ts) — most complex. The bus needs to track an edit-target messageId per stream. Mitigation: prototype this first.
- **Dedup key collisions.** Picking the right key per call site is judgement; document the convention.
- **Latency.** Adding a serialization point shouldn't add >5ms p99. Measure.

## Out of scope

- Inbound message normalisation (TG → bot). That's already concentrated in handlers; not the same problem.
- Web UI message broadcasting (`web/sse.ts`). Independent.
- Persistent message log. Maybe later.

## Note on the channel-relay reply tool

The MCP `reply` tool (used by the desktop CC to push messages to TG) currently routes via the relay → bot → `sendTextReply`. After this phase, that path becomes `relay → bot → MessageBus.send()`. Behaviour identical, but the chain is observable end-to-end with one log schema.
