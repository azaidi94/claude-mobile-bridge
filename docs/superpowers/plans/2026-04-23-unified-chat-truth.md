# Unified Chat Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Telegram topic and Web UI render the same turns in the same order for a given desktop Claude session, regardless of which surface originated each message.

**Architecture:** Every `TailEvent` emitted by `SessionTailer` carries an `originChat` string derived from the channel-relay wrapper. Each surface renders an event iff `event.originChat !== this.ownChat` (own-chat events were already delivered via the TCP fast path, preserving existing dedup). The `watch.ts` auto-watch tailer additionally bridges events to `globalEventBus` for live web SSE.

**Tech Stack:** TypeScript, Bun (test runner + runtime), Hono (web server), grammy (Telegram), React (web UI).

**Spec:** [2026-04-23-unified-chat-truth-design.md](../specs/2026-04-23-unified-chat-truth-design.md).

---

## File Structure

**Modified:**

- `src/sessions/tailer.ts` — `TailEvent` shape (+ `originChat`, `toolName`, `toolInput`); `parseLine` extracts origin and emits user events for channel-tagged messages; tool events carry name/input; `relay_reply` events carry `originChat`.
- `src/handlers/watch.ts` — `case "user"` filters by `originChat` and renders foreign-origin messages; `case "relay_reply"` filters and renders foreign-origin reply text; new `bridgeTailToSse` helper wired into auto-watch tailer callbacks.
- `src/__tests__/tailer.test.ts` — new cases covering origin extraction, channel-tagged dual emission, and tool metadata.
- `src/__tests__/watch.test.ts` — new cases covering origin filter and foreign-origin render paths.

**New:**

- `src/__tests__/sse-bridge.test.ts` — tests for the `bridgeTailToSse` helper: mapping table and `originChat !== "web"` filter.

One file split decision: keep `bridgeTailToSse` inside `src/handlers/watch.ts` (alongside `handleTailEvent`), exported for the test. Extracting to its own module is not justified — it's small and only used by auto-watch.

---

## Task 1: Add `originChat`, `toolName`, `toolInput` fields to `TailEvent`

**Files:**

- Modify: `src/sessions/tailer.ts:27-31` (the `TailEvent` interface)

- [ ] **Step 1: Read the current interface to confirm the exact line range**

Run: `sed -n '19,33p' src/sessions/tailer.ts`
Expected: shows the `TailEventType` union and `TailEvent` interface.

- [ ] **Step 2: Extend the interface**

Replace the `TailEvent` interface with:

```ts
export interface TailEvent {
  type: TailEventType;
  content: string;
  /**
   * Surface-of-origin for channel-relay-routed events.
   * - "web" for web UI sends
   * - A Telegram chat id as string (e.g. "-1003968796171") for Telegram sends
   * - undefined for native-to-session events (terminal-typed user, Claude thinking,
   *   native tool_use that isn't a channel-relay MCP op)
   *
   * Each surface renders `event.originChat !== this.ownChat` to dedup against
   * the TCP fast path that already delivered own-origin messages.
   */
  originChat?: string;
  /** For "tool" events: the raw MCP tool name (e.g. "Read", "Bash"). */
  toolName?: string;
  /** For "tool" events: the raw tool input object as recorded in the JSONL. */
  toolInput?: Record<string, unknown>;
}
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit -p .`
Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/sessions/tailer.ts
git commit -m "feat(tailer): extend TailEvent with originChat, toolName, toolInput

Additive type-only change. No behaviour change yet — subsequent tasks populate
these fields and route consumers read them."
```

---

## Task 2: `parseLine` extracts `originChat` from channel-relay-tagged user messages and emits both `turn_boundary` and `user` events

**Files:**

- Modify: `src/sessions/tailer.ts:161-188` (the `if (entry.type === "user")` branch of `parseLine`)
- Test: `src/__tests__/tailer.test.ts` (add new cases)

Today: a channel-tagged user entry returns only `[{ type: "turn_boundary", content: "" }]` — text is dropped. New behaviour: return `[turn_boundary, user-with-text-and-originChat]`. Non-tagged user entries remain unchanged (user event, `originChat: undefined`).

- [ ] **Step 1: Write failing tests**

Append to `src/__tests__/tailer.test.ts` inside the existing `describe("tailer: parseLine", …)` block:

```ts
test("channel-tagged user message emits turn_boundary AND user event with originChat", () => {
  const line = JSON.stringify({
    type: "user",
    message: {
      content: [
        {
          type: "text",
          text:
            '<channel source="channel-relay" chat_id="web" request_id="r1" ' +
            'user="web" ts="2026-04-23T09:44:29.709Z">hmmm</channel>',
        },
      ],
    },
  });
  const events = tailer.parseLine(line);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ type: "turn_boundary" });
  expect(events[1]).toMatchObject({
    type: "user",
    content: "hmmm",
    originChat: "web",
  });
});

test("channel-tagged user message with Telegram chat id captures it as originChat", () => {
  const line = JSON.stringify({
    type: "user",
    message: {
      content: [
        {
          type: "text",
          text:
            '<channel source="channel-relay" chat_id="-1003968796171" ' +
            'request_id="r2" user="azaidiuk" ts="2026-04-23T10:00:00.000Z">hello from tg</channel>',
        },
      ],
    },
  });
  const events = tailer.parseLine(line);
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({
    type: "user",
    content: "hello from tg",
    originChat: "-1003968796171",
  });
});

test("native (non-tagged) user message emits user event with originChat undefined", () => {
  const line = JSON.stringify({
    type: "user",
    message: { content: "Fix the bug" },
  });
  const events = tailer.parseLine(line);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "user", content: "Fix the bug" });
  expect(events[0]!.originChat).toBeUndefined();
});
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `bun test src/__tests__/tailer.test.ts 2>&1 | tail -10`
Expected: the three new tests fail (first two: `events.length` is 1 not 2; third: already passes if the existing native path is intact — still verify).

- [ ] **Step 3: Implement origin extraction**

Replace the `if (entry.type === "user") { … }` branch at `src/sessions/tailer.ts:161-188` with:

```ts
if (entry.type === "user") {
  const text = this.extractUserText(entry.message?.content);
  if (!text) return [];

  // Channel-relay-wrapped message. Emit turn_boundary (display-reset marker
  // consumed by Telegram's watch.ts) AND a `user` event with the stripped
  // text, tagged with originChat so each surface can dedup against its own
  // TCP fast-path delivery.
  if (text.includes(CHANNEL_RELAY_TAG)) {
    const originChat = extractOriginChatFromTag(text);
    const inner = stripChannelTag(text);
    const events: TailEvent[] = [{ type: "turn_boundary", content: "" }];
    if (inner) {
      events.push({ type: "user", content: inner, originChat });
    }
    return events;
  }

  // Local command output (e.g. /model, /cost) — strip tags and ANSI codes
  const cmdMatch = text.match(
    /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/,
  );
  if (cmdMatch) {
    const cmdOutput = cmdMatch[1]!.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!cmdOutput) return [];
    return [{ type: "user", content: `⌘ ${cmdOutput}` }];
  }

  return [{ type: "user", content: text }];
}
```

- [ ] **Step 4: Add the two helpers at module scope (below `CHANNEL_RELAY_TAG`)**

Insert after the existing `CHANNEL_RELAY_TAG` constant near the top of `src/sessions/tailer.ts`:

```ts
/** Channel-relay wrapper attribute extractor. */
function extractOriginChatFromTag(text: string): string | undefined {
  const m = text.match(/<channel\s[^>]*\bchat_id="([^"]+)"/);
  return m ? m[1] : undefined;
}

/** Strip the `<channel …>…</channel>` wrapper, leaving inner text. */
function stripChannelTag(text: string): string {
  return text
    .replace(/^<channel\s[^>]*>\n?/, "")
    .replace(/\n?<\/channel>\s*$/, "")
    .trim();
}
```

- [ ] **Step 5: Run tailer tests**

Run: `bun test src/__tests__/tailer.test.ts 2>&1 | tail -6`
Expected: all tests pass (previous count + 3 new).

- [ ] **Step 6: Commit**

```bash
git add src/sessions/tailer.ts src/__tests__/tailer.test.ts
git commit -m "feat(tailer): extract originChat from channel-relay wrapper; emit user event alongside turn_boundary

Channel-tagged user entries now yield two events: the existing turn_boundary
(display-reset for Telegram) plus a user event carrying stripped text and
the chat_id attribute from the wrapper. Non-tagged user entries are
unchanged (originChat undefined)."
```

---

## Task 3: `watch.ts case "user"` filters by origin and renders foreign-origin

**Files:**

- Modify: `src/handlers/watch.ts:1100-1120` (existing `case "user"` in `handleTailEvent`)
- Test: `src/__tests__/watch.test.ts`

Current behaviour: unconditionally renders `🖥 <b>Desktop:</b>\n…`. After Task 2, this would incorrectly stamp "Desktop" on web-originated user messages.

Rule:

- `event.originChat === String(ownChatId)` → skip (TCP fast path already delivered)
- `event.originChat === "web"` → render as `🌐 <b>Web:</b>\n…`
- `event.originChat === <other telegram id>` → render as `💬 <b>Chat ${originChat}:</b>\n…` (rare; keeps the origin visible)
- `event.originChat === undefined` → existing Desktop render (terminal-typed)

- [ ] **Step 1: Write failing tests**

Append to `src/__tests__/watch.test.ts` inside the existing `handleTailEvent` describe (or add a new describe block). Use the codebase's existing pattern for mocking `botApi.sendMessage` — match the style already present in that test file. Pseudocode for the three cases (translate to the file's actual mock style):

```ts
// Same-chat origin is skipped (TCP dedup)
// use existing helper — signature is makeState(chatId, threadId, sessionDir)
const state = makeState(-1003968796171, 6302, "/repo/x");
const sent: Array<[number | string, string, unknown]> = [];
const api = {
  sendMessage: (chatId: number | string, text: string, opts: unknown) => {
    sent.push([chatId, text, opts]);
    return Promise.resolve({ message_id: 1 });
  },
  deleteMessage: () => Promise.resolve(),
} as unknown as Api;

handleTailEvent(
  api,
  state,
  { type: "user", content: "hi", originChat: "-1003968796171" },
  6302,
);

expect(sent).toHaveLength(0);

// Web origin renders with Web label
handleTailEvent(
  api,
  state,
  { type: "user", content: "hmmm", originChat: "web" },
  6302,
);
expect(sent).toHaveLength(1);
expect(sent[0]![1]).toContain("🌐");
expect(sent[0]![1]).toContain("Web");
expect(sent[0]![1]).toContain("hmmm");

// Undefined (terminal-typed) still renders Desktop
handleTailEvent(
  api,
  state,
  { type: "user", content: "native", originChat: undefined },
  6302,
);
expect(sent).toHaveLength(2);
expect(sent[1]![1]).toContain("🖥");
expect(sent[1]![1]).toContain("Desktop");
```

If `src/__tests__/watch.test.ts` doesn't have established helpers for `makeState` or a mock `Api`, follow the closest existing pattern in that file — grep `bun test src/__tests__/watch.test.ts -t "<existing passing test name>"` and copy its setup verbatim.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bun test src/__tests__/watch.test.ts 2>&1 | tail -10`
Expected: the three new cases fail (case 1: `sent.length` is 1 because current code unconditionally sends; case 2 & 3: the message text lacks the new label or is mislabelled).

- [ ] **Step 3: Implement the filter + render switch**

In `src/handlers/watch.ts`, replace the existing `case "user"` block (search for the current `🖥 <b>Desktop:</b>` line — around 1100-1120) with:

```ts
case "user": {
  const ownChat = String(chatId);
  if (event.originChat === ownChat) {
    // TCP fast-path already delivered this user's own Telegram message.
    break;
  }

  resetDisplaySegment(botApi, state);

  const preview =
    event.content.length > 300
      ? event.content.slice(0, 300) + "…"
      : event.content;
  const formatted = convertMarkdownToHtml(preview);

  let labelHtml: string;
  let labelPlain: string;
  if (event.originChat === undefined) {
    labelHtml = `🖥 <b>Desktop:</b>`;
    labelPlain = `🖥 Desktop:`;
  } else if (event.originChat === "web") {
    labelHtml = `🌐 <b>Web:</b>`;
    labelPlain = `🌐 Web:`;
  } else {
    labelHtml = `💬 <b>Chat ${escapeHtml(event.originChat)}:</b>`;
    labelPlain = `💬 Chat ${event.originChat}:`;
  }

  botApi
    .sendMessage(chatId, `${labelHtml}\n${formatted}`, {
      parse_mode: "HTML",
      ...threadOpts,
    })
    .catch((err) => {
      debug(`tail user: ${err}`);
      botApi
        .sendMessage(chatId, `${labelPlain}\n${preview}`, threadOpts)
        .catch(() => {});
    });
  break;
}
```

Ensure `escapeHtml` is imported in `watch.ts`. Run `grep -n "escapeHtml" src/handlers/watch.ts` — if it's already imported, reuse it; otherwise add the import from `../formatting` (confirm with `grep -n "export.*escapeHtml" src/formatting.ts` first).

- [ ] **Step 4: Run watch tests**

Run: `bun test src/__tests__/watch.test.ts 2>&1 | tail -10`
Expected: new cases pass; previously-passing cases still pass.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/watch.ts src/__tests__/watch.test.ts
git commit -m "feat(watch): filter user events by originChat; render Web/Chat labels

Telegram topic renders its own chat id only via the existing TCP fast path
(skip in tailer). Other origins get a distinct label (🌐 Web, 💬 Chat <id>,
🖥 Desktop for terminal-typed). No behaviour change for Telegram-originated
messages or the topic's typing indicator."
```

---

## Task 4: `parseLine` extracts `originChat` from `mcp__channel-relay__reply` tool_use

**Files:**

- Modify: `src/sessions/tailer.ts:205-217` (the `if (block.type === "tool_use")` branch in the assistant block loop)
- Test: `src/__tests__/tailer.test.ts`

- [ ] **Step 1: Write failing test**

```ts
test("mcp__channel-relay__reply emits relay_reply event with originChat from input.chat_id", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "mcp__channel-relay__reply",
          input: { request_id: "r1", chat_id: "web", text: "hello back" },
        },
      ],
    },
  });
  const events = tailer.parseLine(line);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "relay_reply",
    content: "hello back",
    originChat: "web",
  });
});

test("mcp__channel-relay__edit_message also carries originChat", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "mcp__channel-relay__edit_message",
          input: {
            chat_id: "-1003968796171",
            message_id: 42,
            text: "edited",
          },
        },
      ],
    },
  });
  const events = tailer.parseLine(line);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "relay_reply",
    content: "edited",
    originChat: "-1003968796171",
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test src/__tests__/tailer.test.ts 2>&1 | tail -8`
Expected: two new tests fail (relay_reply currently emitted without `originChat`).

- [ ] **Step 3: Implement**

Find the block in `src/sessions/tailer.ts` that matches:

```ts
if (
  block.name === "mcp__channel-relay__reply" ||
  block.name === "mcp__channel-relay__edit_message"
) {
  const text = String(input.text || "");
  if (text) events.push({ type: "relay_reply", content: text });
  continue;
}
```

Replace with:

```ts
if (
  block.name === "mcp__channel-relay__reply" ||
  block.name === "mcp__channel-relay__edit_message"
) {
  const text = String(input.text || "");
  const originChat =
    typeof input.chat_id === "string" ? input.chat_id : undefined;
  if (text) {
    events.push({ type: "relay_reply", content: text, originChat });
  }
  continue;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/tailer.test.ts 2>&1 | tail -6`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/tailer.ts src/__tests__/tailer.test.ts
git commit -m "feat(tailer): relay_reply events carry originChat from tool input.chat_id"
```

---

## Task 5: `watch.ts case "relay_reply"` filters by origin and sends foreign-origin reply text

**Files:**

- Modify: `src/handlers/watch.ts:1076-1098` (existing `case "relay_reply"`)
- Test: `src/__tests__/watch.test.ts`

Current behaviour: sets `finalReplyReceived`, runs `resetDisplaySegment` — no send (TCP fast path delivers). After this change: for foreign-origin replies, ALSO send the text to this Telegram chat before the cleanup.

- [ ] **Step 1: Write failing tests**

Append to `src/__tests__/watch.test.ts` (same describe block as Task 3). Pseudocode — match the file's mock style:

```ts
test("relay_reply with own chat id only cleans up (no send)", () => {
  const state = makeState(-1003968796171, 6302, "/repo/x");
  const sent: unknown[] = [];
  const api = {
    sendMessage: (...args: unknown[]) => {
      sent.push(args);
      return Promise.resolve({ message_id: 1 });
    },
    deleteMessage: () => Promise.resolve(),
  } as unknown as Api;

  handleTailEvent(
    api,
    state,
    { type: "relay_reply", content: "hello", originChat: "-1003968796171" },
    6302,
  );
  expect(sent).toHaveLength(0);
});

test("relay_reply with foreign origin sends text AND cleans up", () => {
  const state = makeState(-1003968796171, 6302, "/repo/x");
  const sent: Array<{ chatId: unknown; text: string }> = [];
  const api = {
    sendMessage: (chatId: unknown, text: string) => {
      sent.push({ chatId, text });
      return Promise.resolve({ message_id: 1 });
    },
    deleteMessage: () => Promise.resolve(),
  } as unknown as Api;

  handleTailEvent(
    api,
    state,
    { type: "relay_reply", content: "from web", originChat: "web" },
    6302,
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]!.text).toContain("from web");
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test src/__tests__/watch.test.ts 2>&1 | tail -10`
Expected: the second new test fails (no send happens today).

- [ ] **Step 3: Implement**

Replace the existing `case "relay_reply"` block in `src/handlers/watch.ts` with:

```ts
case "relay_reply": {
  const ownChat = String(chatId);
  const isForeignOrigin =
    event.originChat !== undefined && event.originChat !== ownChat;

  if (isForeignOrigin) {
    // Foreign-origin reply: TCP fast path delivered to the origin surface,
    // not to this Telegram chat. Render the reply text here.
    const formatted = convertMarkdownToHtml(event.content);
    botApi
      .sendMessage(chatId, formatted, {
        parse_mode: "HTML",
        ...threadOpts,
      })
      .catch((err) => {
        debug(`tail relay_reply foreign: ${err}`);
        botApi
          .sendMessage(chatId, event.content, threadOpts)
          .catch(() => {});
      });
  }

  // Existing cleanup (preserves TCP-path dedup for own-origin).
  if (state.finalReplyReceived !== undefined) {
    state.finalReplyReceived = true;
  }
  resetDisplaySegment(botApi, state);
  break;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/watch.test.ts 2>&1 | tail -6`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/watch.ts src/__tests__/watch.test.ts
git commit -m "feat(watch): render foreign-origin relay_reply in Telegram topic

When Claude's mcp__channel-relay__reply targeted a non-Telegram surface
(e.g. chat_id=web), the TCP path didn't reach this topic. Now the tailer
fans the reply text here too, while own-origin replies remain skipped
(TCP already delivered)."
```

---

## Task 6: Tool events carry `toolName` and `toolInput`

**Files:**

- Modify: `src/sessions/tailer.ts:205-220` (the native tool_use branch — not the channel-relay one Task 4 already touched)
- Test: `src/__tests__/tailer.test.ts`

- [ ] **Step 1: Write failing test**

```ts
test("native tool_use carries toolName and toolInput on the tool event", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Read",
          input: { file_path: "/x/y.ts" },
        },
      ],
    },
  });
  const events = tailer.parseLine(line);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "tool",
    toolName: "Read",
    toolInput: { file_path: "/x/y.ts" },
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test src/__tests__/tailer.test.ts -t "toolName and toolInput" 2>&1 | tail -6`
Expected: fails (currently `events[0]` has no `toolName`/`toolInput`).

- [ ] **Step 3: Implement**

In `src/sessions/tailer.ts`, find the lines that emit tool events:

```ts
const toolDisplay = formatToolStatus(block.name, input);
events.push({ type: "tool", content: toolDisplay });
```

Replace with:

```ts
const toolDisplay = formatToolStatus(block.name, input);
events.push({
  type: "tool",
  content: toolDisplay,
  toolName: block.name,
  toolInput: input,
});
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/tailer.test.ts 2>&1 | tail -6`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/tailer.ts src/__tests__/tailer.test.ts
git commit -m "feat(tailer): carry toolName and toolInput on tool events

Web UI's SSE consumer (next task) needs these to render ToolBlock cards
with the same fidelity as the /history replay endpoint. No behaviour
change for existing Telegram renderer (ignores extra fields)."
```

---

## Task 7: Web SSE bridge from tailer to `globalEventBus`

**Files:**

- Modify: `src/handlers/watch.ts` (export a new `bridgeTailToSse` helper + call it from the auto-watch tailer callbacks)
- Test: `src/__tests__/sse-bridge.test.ts` (new file)

Auto-watch tailer instantiations to wire up: `watch.ts:414` (tailer restart) and `watch.ts:540` (initial auto-watch). Also add to `watch.ts:747` (watch-command path) for completeness. Do NOT add to `src/handlers/relay-bridge.ts:82` — that's a short-lived tailer for TCP relay delivery only.

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/sse-bridge.test.ts`:

```ts
import "./ensure-test-env";
import { describe, test, expect, beforeEach } from "bun:test";
import type { TailEvent } from "../sessions/tailer";
import type { SseEvent } from "../web/sse";
import { bridgeTailToSse } from "../handlers/watch";

describe("bridgeTailToSse", () => {
  let emitted: Array<{ sessionId: string; event: SseEvent }>;
  const bus = {
    emit(sessionId: string, event: SseEvent) {
      emitted.push({ sessionId, event });
    },
  };
  const SID = "sess-1";

  beforeEach(() => {
    emitted = [];
  });

  test("skips events whose originChat is web (already delivered optimistically)", () => {
    const e: TailEvent = { type: "text", content: "x", originChat: "web" };
    bridgeTailToSse(bus, SID, e);
    expect(emitted).toEqual([]);
  });

  test("user event → text SseEvent with › prefix", () => {
    const e: TailEvent = {
      type: "user",
      content: "hello",
      originChat: "-1003968796171",
    };
    bridgeTailToSse(bus, SID, e);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toMatchObject({
      type: "text",
      content: "› hello",
    });
  });

  test("text event passes through", () => {
    bridgeTailToSse(bus, SID, { type: "text", content: "from claude" });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toMatchObject({
      type: "text",
      content: "from claude",
    });
  });

  test("tool event carries toolName and toolInput", () => {
    bridgeTailToSse(bus, SID, {
      type: "tool",
      content: "Read(/x)",
      toolName: "Read",
      toolInput: { file_path: "/x" },
    });
    expect(emitted[0]!.event).toMatchObject({
      type: "tool",
      content: "Read(/x)",
      toolName: "Read",
      toolInput: { file_path: "/x" },
    });
  });

  test("thinking passes through", () => {
    bridgeTailToSse(bus, SID, { type: "thinking", content: "pondering…" });
    expect(emitted[0]!.event.type).toBe("thinking");
  });

  test("relay_reply maps to text", () => {
    bridgeTailToSse(bus, SID, {
      type: "relay_reply",
      content: "answer",
      originChat: "-1003968796171",
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toMatchObject({
      type: "text",
      content: "answer",
    });
  });

  test("turn_boundary is dropped (web has no display-reset concept)", () => {
    bridgeTailToSse(bus, SID, { type: "turn_boundary", content: "" });
    expect(emitted).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test src/__tests__/sse-bridge.test.ts 2>&1 | tail -5`
Expected: fails at import (`bridgeTailToSse` does not exist yet).

- [ ] **Step 3: Implement `bridgeTailToSse`**

Add to `src/handlers/watch.ts` (near the top, after imports, before `handleTailEvent`):

```ts
import type { SseEvent } from "../web/sse";

interface SseBus {
  emit(sessionId: string, event: SseEvent): void;
}

/**
 * Map a TailEvent to an SseEvent and emit it to the session's SSE bus.
 * Skips own-origin events (the web client optimistically added its own send;
 * echoing via SSE would duplicate). Web-specific drop: turn_boundary has no
 * display-reset semantics in the web renderer.
 */
export function bridgeTailToSse(
  bus: SseBus,
  sessionId: string,
  event: TailEvent,
): void {
  if (event.originChat === "web") return;

  switch (event.type) {
    case "user":
      bus.emit(sessionId, { type: "text", content: `› ${event.content}` });
      return;
    case "text":
      bus.emit(sessionId, { type: "text", content: event.content });
      return;
    case "tool":
      bus.emit(sessionId, {
        type: "tool",
        content: event.content,
        toolName: event.toolName,
        toolInput: event.toolInput,
      });
      return;
    case "thinking":
      bus.emit(sessionId, { type: "thinking", content: event.content });
      return;
    case "relay_reply":
      bus.emit(sessionId, { type: "text", content: event.content });
      return;
    case "turn_boundary":
      return;
  }
}
```

- [ ] **Step 4: Run the new test file**

Run: `bun test src/__tests__/sse-bridge.test.ts 2>&1 | tail -6`
Expected: all 7 tests pass.

- [ ] **Step 5: Wire the bridge into auto-watch tailer callbacks**

In `src/handlers/watch.ts`, find each `new SessionTailer(…, (event: TailEvent) => { … })` instantiation and add a `bridgeTailToSse` call alongside the existing `handleTailEvent`. Locations:

- Around line 414 (tailer restart on fresh conversation id):

  ```ts
  const newTailer = new SessionTailer(newPath, (event: TailEvent) => {
    handleTailEvent(botApi, displayState, event, threadId);
    bridgeTailToSse(globalEventBus, sessionId, event);
  });
  ```

- Around line 540 (initial auto-watch setup):

  ```ts
  const tailer = new SessionTailer(jsonlPath, (event: TailEvent) => {
    handleTailEvent(botApi, displayState, event, threadId);
    bridgeTailToSse(globalEventBus, sessionId, event);
  });
  ```

- Around line 747 (watch-command path):
  ```ts
  const tailer = new SessionTailer(jsonlPath, (event: TailEvent) => {
    handleTailEvent(ctx.api, displayState, event, threadId);
    bridgeTailToSse(globalEventBus, sessionId, event);
  });
  ```

At the top of `watch.ts`, add the globalEventBus import if not already present:

```ts
import { globalEventBus } from "../web/sse";
```

(Check first with `grep "globalEventBus" src/handlers/watch.ts` — if already imported, skip.)

- [ ] **Step 6: Typecheck and run full isolated suite**

Run:

```bash
bunx tsc --noEmit -p .
bun run test 2>&1 | awk '/^ +[0-9]+ pass$/{p+=$1} /^ +[0-9]+ fail$/{f+=$1} END{print "pass="p" fail="f}'
```

Expected: `tsc` exit 0; `fail=0`.

- [ ] **Step 7: Commit**

```bash
git add src/handlers/watch.ts src/__tests__/sse-bridge.test.ts
git commit -m "feat(watch): bridge tailer events to globalEventBus for live web SSE

Every auto-watch tailer now emits a mapped SseEvent to the session's
event bus alongside its Telegram rendering. originChat=web is skipped
(web client optimistic-adds its own sends); turn_boundary is dropped
(web has no display-reset concept). Telegram-originated and
terminal-typed events now reach the web UI live."
```

---

## Task 8: End-to-end manual verification

**Files:** none (smoke test).

- [ ] **Step 1: Rebuild frontend**

Run:

```bash
cd web && bun run build
```

(Frontend had no code changes in this plan; rebuild is only needed if you ship alongside other frontend work. If `web/src/**` was untouched, skip.)

- [ ] **Step 2: Restart the bot**

Run: `launchctl kickstart -k "gui/$(id -u)/com.azaidi.claude-bot"`

- [ ] **Step 3: Verify startup logs**

Run: `sleep 2 && tail -30 /tmp/claude-bot.log`
Expected: `topic-manager: reconciled N session(s)` + `auto-watch: started` lines for each online session — nothing new to worry about here, the change is additive.

- [ ] **Step 4: Send a message from the web UI to an auto-watched session**

In the Telegram mini-app, open the session and send any message. Expected:

- Web UI shows it optimistically as a "You" turn (existing behaviour).
- Telegram topic shows it as `🌐 Web: <text>` (new rendering from Task 3).
- Both show Claude's reply text (web via TCP, Telegram via Task 5's foreign-origin relay_reply render).

- [ ] **Step 5: Send a message from Telegram to the same session**

From the Telegram topic itself, send a message. Expected:

- Telegram topic shows your own message (TCP fast path, unchanged).
- Web UI receives it live via SSE as a `› You` turn (Task 7 bridge).
- Claude's reply shows in Telegram (TCP), and also in the web UI (Task 7 bridges the relay_reply).

- [ ] **Step 6: Type directly in the desktop Claude terminal**

Type anything directly in the Claude TUI for the same session. Expected:

- Telegram topic shows `🖥 Desktop: <text>` (existing behaviour, preserved).
- Web UI shows a `🖥 Desktop` turn live (Task 7 bridge).

- [ ] **Step 7: Final commit if any manual fixes were needed**

If Steps 4–6 revealed nothing, no commit needed. If you had to tweak a label or padding, `git add` + commit with a focused message.

---

## Scope coverage self-check

- Spec §1 (originChat data model) → Task 1
- Spec §2 (tailer user/reply extraction) → Tasks 2, 4
- Spec §2 (tool metadata) → Task 6
- Spec §3 (watch.ts user + relay_reply filter and foreign-origin render) → Tasks 3, 5
- Spec §4 (web SSE bridge) → Task 7
- Spec §5 (dedup matrix) — enforced by Tasks 3, 5, 7
- Spec §6 (terminal-typed render to web, scope 6a) — delivered by Task 7's `user` mapping (undefined originChat still bridges); terminal-typed already renders to Telegram (unchanged).
- Spec test matrix items 1–11 → covered across `tailer.test.ts` (Tasks 2, 4, 6), `watch.test.ts` (Tasks 3, 5), `sse-bridge.test.ts` (Task 7).

No placeholders. No TBDs.
