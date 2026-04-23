# Unified Chat Truth Across Telegram & Web UI

Status: design (approved sections 1–5; open question section 6 → **6a** provisionally taken; user can override at spec review)

## Problem

A single desktop Claude session drives multiple "viewports":

- **Telegram** — a topic in the forum group, tied to the session via auto-watch.
- **Web UI** — a session view at `/sessions/:id`, fed by `/history` replay + an SSE live stream.
- **Desktop terminal** — where Claude actually runs. **Out of scope** per user direction.

Today each viewport filters events differently, so a message typed in one surface is often invisible in the other. Concrete failure witnessed 2026-04-23: user typed "hmmm" in the web UI. Web UI showed user message + Claude reply. Telegram topic showed neither. Terminal showed the user message but not the reply.

## Goal

Telegram topic and Web UI render the **same turns in the same order**, regardless of which surface originated each message. Formatting may differ per medium (Markdown, HTML, ANSI). The source of truth is the session JSONL, already authoritative today. No change to Telegram's behaviour for Telegram-originated messages.

## Non-goals

- Terminal display parity. The terminal is Claude's own process output; making it echo replies requires changing the channel-relay MCP instruction and is explicitly out of scope.
- Retiring the TCP fast-path. TCP delivery stays as today; it just stops being the only delivery path for cross-surface messages.
- Multi-user authorisation or access-control rework.

## Approach (A of A/B/C, minimal surgery)

**Core idea:** every `TailEvent` carries an `originChat` tag derived from the channel-relay wrapper. Each surface renders an event iff `event.originChat !== this.ownChat`. Surface's own-origin messages were already delivered via the TCP fast path, so skipping them preserves existing dedup.

## Data model

```ts
// src/sessions/tailer.ts
interface TailEvent {
  type: TailEventType; // existing union
  content: string;
  originChat?: string; // NEW — "web" | telegram chat id string | undefined
  toolName?: string; // NEW — for "tool" events, enables web ToolBlock
  toolInput?: Record<string, unknown>; // NEW — same
}
```

`originChat` values:

- `"web"` — channel tag `chat_id="web"`.
- Telegram chat id as string (e.g. `"-1003968796171"`) — channel tag `chat_id="<id>"`.
- `undefined` — native-to-session events: terminal-typed user messages (no wrapper), Claude `thinking` blocks, native tool_use calls that aren't MCP channel-relay ops.

Extraction sites:

- User JSONL entries containing `<channel source="channel-relay" chat_id="X" …>` — regex out `chat_id="([^"]+)"`.
- `mcp__channel-relay__{reply,edit_message,react}` tool_use blocks — read `block.input.chat_id`.

## Tailer changes (`src/sessions/tailer.ts`)

### User messages

Current behaviour for a channel-tagged user entry:

```ts
if (text.includes(CHANNEL_RELAY_TAG)) {
  return [{ type: "turn_boundary", content: "" }];
}
```

New behaviour: emit **both** a `turn_boundary` (preserves Telegram display-reset logic) **and** a `user` event with text stripped of the channel wrapper, carrying `originChat`. Tagged-text extraction reuses `stripChannelTag` from `src/sessions/history.ts` (or moves it to a shared util).

Native (no wrapper) user messages continue to emit `{type: "user", content}` with `originChat: undefined` — unchanged.

### Assistant relay replies

`mcp__channel-relay__reply` emits a `relay_reply` event as today, now with `originChat` set from `input.chat_id`. `edit_message` and `react` unchanged behaviourally (react still skipped; edit_message still emits as `relay_reply`).

### Tool blocks (not relay)

Tool events gain `toolName` and `toolInput` fields (free consistency with the web `/history` endpoint that already surfaces these).

## Telegram renderer changes (`src/handlers/watch.ts`)

Add `case "user"` to `handleTailEvent`. Add filter to `case "user"` and `case "relay_reply"`.

Rule for both: render iff `event.originChat !== ownChat` **or** `event.originChat === undefined` (terminal-typed — scope 6a).

### `case "user"`

```ts
case "user": {
  if (event.originChat === ownChat) break;  // TCP already delivered
  // send user event as a Telegram message in the topic.
  // Use an origin prefix so it's clear where the message came from, e.g.
  //   "› [web] hmmm"
  // Styling: reuse the existing "user" display treatment.
  break;
}
```

### `case "relay_reply"`

Keep existing cleanup (`resetDisplaySegment`, set `finalReplyReceived`). **Additionally**, if `event.originChat !== ownChat`, send `event.content` as a Telegram message in the topic before cleanup.

### Unchanged cases

`thinking`, `tool`, `text`, `turn_boundary` render exactly as today for Telegram.

## Web SSE bridge (new, ~20 lines in the auto-watch setup path)

The auto-watch setup creates one `SessionTailer` per desktop session. Extend the callback to also emit a mapped `SseEvent` to `globalEventBus` on `sessionId`, with filter `originChat !== "web"`.

Mapping (TailEvent → SseEvent):

| TailEvent       | SseEvent                            | Notes                                                        |
| --------------- | ----------------------------------- | ------------------------------------------------------------ |
| `user`          | `text` with `\`› ${content}\``      | matches history-replay convention                            |
| `text`          | `text`                              | pass-through                                                 |
| `tool`          | `tool` with `toolName`, `toolInput` | fills ToolBlock                                              |
| `thinking`      | `thinking`                          | pass-through                                                 |
| `relay_reply`   | `text`                              | matches `src/web/sessions/history.ts` fix shipped 2026-04-23 |
| `turn_boundary` | —                                   | dropped (web has no boundary concept)                        |

Web client code is untouched. ChatPage's existing optimistic local-add on send remains; the `originChat !== "web"` filter guarantees SSE never echoes the client's own send back.

## Dedup matrix (correctness contract)

Rule: `event.originChat === ownChat → skip`. Otherwise render.

| Origin of event                             | Rendered in Telegram chat A | Rendered in Telegram chat B | Rendered in Web UI       |
| ------------------------------------------- | --------------------------- | --------------------------- | ------------------------ |
| Telegram chat A user msg                    | **skip** (TCP)              | render (tailer)             | render (SSE)             |
| Web user msg                                | render (tailer)             | render (tailer)             | **skip** (optimistic)    |
| Terminal-typed user msg (no originChat)     | render [6a]                 | render [6a]                 | render [6a]              |
| Telegram chat A reply                       | **skip** (TCP)              | render                      | render                   |
| Web reply                                   | render                      | render                      | **skip** (TCP fast path) |
| Claude thinking / native tool / native text | render                      | render                      | render                   |

## Scope clarification — terminal-typed user messages (section 6 open question)

Today when the user types directly in the desktop terminal, the JSONL records a plain `type: "user"` entry with no channel tag. Tailer emits `{type: "user"}` with `originChat: undefined`. Neither Telegram nor Web renders it because `watch.ts` has no `case "user"` and the web SSE bridge doesn't exist yet.

This spec takes **option 6a**: when `originChat === undefined`, render to both Telegram and Web. Terminal-typed input becomes visible on the other surfaces, removing a real blind spot.

If user review vetoes 6a, both renderers gain a guard: `if (event.originChat === undefined) break;` — trivial revert.

## Test matrix

New tests in `src/__tests__/`:

1. `tailer: parseLine` — channel-tagged user message emits `[turn_boundary, user{originChat:"web"}]` and text is stripped of wrapper.
2. `tailer: parseLine` — channel-tagged user message with Telegram chat_id emits `originChat: "<that id>"`.
3. `tailer: parseLine` — `mcp__channel-relay__reply` emits `relay_reply` with `originChat` from `input.chat_id`.
4. `tailer: parseLine` — native user message emits `{type: "user", originChat: undefined}`.
5. `watch: handleTailEvent` — `user` event with `originChat === ownChat` is skipped.
6. `watch: handleTailEvent` — `user` event with `originChat !== ownChat` triggers `api.sendMessage`.
7. `watch: handleTailEvent` — `relay_reply` with `originChat === ownChat` only cleans up (no send).
8. `watch: handleTailEvent` — `relay_reply` with `originChat !== ownChat` sends text AND cleans up.
9. `web sse bridge` — tailer events with `originChat !== "web"` emit mapped SseEvents to `globalEventBus`.
10. `web sse bridge` — tailer events with `originChat === "web"` do NOT emit to `globalEventBus`.
11. `web sse bridge` — `turn_boundary` is not forwarded to SSE.

End-to-end (optional, if fixture allows):

- Synth JSONL with mixed Telegram-origin + web-origin + terminal-native entries; assert Telegram rendering and SSE stream rendering match the matrix.

## Files touched

- `src/sessions/tailer.ts` — data model, extraction, emit `user` + `turn_boundary` for tagged messages, carry `toolName`/`toolInput`/`originChat`.
- `src/handlers/watch.ts` — add `case "user"`; extend `case "relay_reply"` with origin filter + send path; preserve existing dedup for own-chat.
- `src/handlers/watch.ts` — add SSE bridge callback. The auto-watch tailer is instantiated at `watch.ts:540` and the tailer-restart path at `watch.ts:414`; both callbacks gain the SSE emit. A separate tailer exists at `watch.ts:747` (watch-command path) and at `src/handlers/relay-bridge.ts:82` (explicit-relay path) — both get the same bridge for completeness.
- `src/__tests__/tailer.test.ts` — new parseLine cases.
- `src/__tests__/watch.test.ts` — new handleTailEvent cases.
- New test file `src/__tests__/sse-bridge.test.ts` — bridge behaviour.

## Risks & mitigations

- **Duplicate-message regression** (memory flags 2026-04-08 incident). Mitigation: the `originChat === ownChat → skip` rule is the exact dedup boundary. Tests 5–8 in the matrix are the regression guard. No change to TCP paths.
- **Channel tag parsing brittleness.** Channel-relay tag format is currently `<channel source="channel-relay" chat_id="…" …>`. Mitigation: tolerant regex (`chat_id="([^"]+)"`), graceful `originChat: undefined` fallback if attr missing.
- **Web UI flooding** if an auto-watched long-running session replays many events to SSE. Mitigation: the bridge is event-driven, not replay; only new tailer events flow. Web `/history` replay is unchanged.
- **Memory/resource leak** from SSE bridge per session. Mitigation: bridge subscription tied to the existing tailer lifecycle; when the tailer stops, the bridge stops.

## Rollout

Single PR. No feature flag. Changes are additive for Telegram (new rendering for foreign-origin events, no change for own-origin) and strictly additive for Web (new SSE delivery path; nothing removed). If the PR causes problems the revert is a straight `git revert`.

## Open items for user review

- **Confirm 6a** (terminal-typed messages render to Telegram + Web) or flip to 6b/6c.
- **Origin prefix style in Telegram** for foreign-origin user messages. Proposed: `› [web] hmmm`. Alternative: no prefix (matches own-origin style exactly) — simpler but loses the provenance cue.
