# Tool Results & Session-State Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface three categories of JSONL events that we currently drop — `tool_result`, `permission-mode`, and `system → stop_hook_summary` — in both web UI and Telegram, mirroring the way Claude Code's TUI renders them.

**Architecture:** Three new `TailEventType` members. Tailer parses each from the JSONL. Web SSE bridge forwards them. Web client correlates `tool_result` to the originating `tool_use` via `Map<toolUseId, ToolResult>`; renders inline in the same `ToolBlock`. Telegram handles each case in `handleTailEvent` — selective promotion for tool_result (PROMOTE_ON_SUCCESS = Bash, Grep, Glob, Task, Agent, WebFetch, WebSearch; otherwise ephemeral); always-rendered banners for permission_mode (deduplicated) and hook_summary.

**Tech Stack:** TypeScript, Bun (test runner + runtime), grammy (Telegram), React (web UI), Hono (web server).

**Spec:** [`2026-04-23-tool-results-and-session-events.md`](../specs/2026-04-23-tool-results-and-session-events.md). **TUI reference:** [`docs/superpowers/notes/2026-04-23-claude-code-tui-rendering.md`](../notes/2026-04-23-claude-code-tui-rendering.md).

---

## File Structure

**Modified:**

- `src/sessions/tailer.ts` — `TailEventType` and `TailEvent` extended; new `parseLine` branches for `tool_result`, `permission-mode`, `system→stop_hook_summary`; new `extractToolResultText` helper.
- `src/handlers/watch.ts` — `bridgeTailToSse` extended; `WatchState` gains `toolUseRegistry` + `lastPermissionMode`; three new `case` blocks in `handleTailEvent`.
- `src/formatting.ts` — new `formatToolResultSummary` helper.
- `src/web/sse.ts` — `SseEvent` shape extended.
- `src/web/sessions/history.ts` — `mapUserEntry` handles `tool_result` blocks; new top-level handlers for `permission-mode` and `system` entries.
- `web/src/api.ts` — client-side `SseEvent` type extended.
- `web/src/components/Terminal.tsx` — `ToolBlock` accepts `result` prop; new `ToolResultBody`, `PermissionModeBanner`, `HookSummaryCard`; `Map<toolUseId, ToolResult>` correlation in the `Terminal` component.

**Test files (modified):**

- `src/__tests__/tailer.test.ts`
- `src/__tests__/watch.test.ts`
- `src/__tests__/sse-bridge.test.ts`
- `src/__tests__/web-sessions-history.test.ts`
- `web/src/__tests__/Terminal.test.tsx`

No new files. The new render components live inside `Terminal.tsx` (small enough; matches existing convention where `DiffLines`, `ToolBlock` are colocated).

---

## Task 1: Extend `TailEvent` shape with new types and fields

**Files:**

- Modify: `src/sessions/tailer.ts` — `TailEventType` union (around line 19) and `TailEvent` interface (around line 27).

- [ ] **Step 1: Read the current shape**

Run: `sed -n '17,80p' src/sessions/tailer.ts`
Expected: shows the existing `TailEventType` union and `TailEvent` interface with current fields.

- [ ] **Step 2: Extend the union and interface**

Replace the existing `TailEventType` union and `TailEvent` interface with:

```ts
export type TailEventType =
  | "user"
  | "text"
  | "tool"
  | "thinking"
  | "turn_boundary"
  | "relay_reply"
  | "tool_result"
  | "permission_mode"
  | "hook_summary";

export interface TailEvent {
  type: TailEventType;
  content: string;
  /**
   * Surface-of-origin for channel-relay-routed events.
   * - "web" for web UI sends
   * - A Telegram chat id as string (e.g. "-1003968796171") for Telegram sends
   * - undefined for native-to-session events
   */
  originChat?: string;
  /** For "tool" events: the raw MCP tool name (e.g. "Read", "Bash"). */
  toolName?: string;
  /** For "tool" events: the raw tool input object as recorded in the JSONL. */
  toolInput?: Record<string, unknown>;
  /** For "tool_result" events: pairs the result with its tool_use block. */
  toolUseId?: string;
  /** For "tool_result" events: true when the tool reported failure. */
  isError?: boolean;
  /** For "permission_mode" events: the new permission mode value. */
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  /** For "hook_summary" events: parsed details of the stop-hook run. */
  hook?: {
    hookCount: number;
    errorCount: number;
    preventedContinuation: boolean;
    firstError?: string;
    failingHookName?: string;
  };
}
```

Preserve `TailCallback` and other types in the surrounding file as-is.

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit -p .`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/sessions/tailer.ts
git commit -m "feat(tailer): extend TailEvent with tool_result/permission_mode/hook_summary types

Type-only additive change. Subsequent tasks populate these fields and
route consumers read them."
```

---

## Task 2: Tailer extracts `permission_mode` events

**Files:**

- Modify: `src/sessions/tailer.ts` — `parseLine`, add a new dispatch branch.
- Test: `src/__tests__/tailer.test.ts` — add new case.

- [ ] **Step 1: Write failing test**

Append inside the existing `describe("tailer: parseLine", …)` block in `src/__tests__/tailer.test.ts`:

```ts
test("permission-mode entry emits permission_mode event", () => {
  const line = JSON.stringify({
    type: "permission-mode",
    permissionMode: "plan",
    sessionId: "sess-1",
  });
  const events = tailer.parseLine(line);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "permission_mode",
    content: "plan",
    permissionMode: "plan",
  });
});

test("permission-mode entry without a string permissionMode is dropped", () => {
  const line = JSON.stringify({
    type: "permission-mode",
    sessionId: "sess-1",
  });
  expect(tailer.parseLine(line)).toEqual([]);
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun test src/__tests__/tailer.test.ts -t "permission-mode" 2>&1 | tail -8`
Expected: 2 fails (parseLine returns `[]` today for this top-level type).

- [ ] **Step 3: Implement the dispatch branch**

In `src/sessions/tailer.ts`, locate `parseLine`. Find the `if (entry.type === "user") { … }` branch. Immediately AFTER the closing `}` of the user branch (before the `assistant` branch), add:

```ts
if (entry.type === "permission-mode") {
  const mode = entry.permissionMode;
  if (typeof mode !== "string") return [];
  return [
    {
      type: "permission_mode",
      content: mode,
      permissionMode: mode as TailEvent["permissionMode"],
    },
  ];
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/tailer.test.ts 2>&1 | tail -8`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/tailer.ts src/__tests__/tailer.test.ts
git commit -m "feat(tailer): emit permission_mode events from JSONL permission-mode entries"
```

---

## Task 3: Tailer extracts `hook_summary` events from `system` entries

**Files:**

- Modify: `src/sessions/tailer.ts` — `parseLine`, add another dispatch branch.
- Test: `src/__tests__/tailer.test.ts`.

- [ ] **Step 1: Write failing test**

```ts
test("system stop_hook_summary with errors emits hook_summary event", () => {
  const line = JSON.stringify({
    type: "system",
    subtype: "stop_hook_summary",
    hookCount: 3,
    hookErrors: [{ name: "lint", error: "Unfixable lint error" }],
    preventedContinuation: true,
  });
  const events = tailer.parseLine(line);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "hook_summary",
    content: "Unfixable lint error",
    hook: {
      hookCount: 3,
      errorCount: 1,
      preventedContinuation: true,
      firstError: "Unfixable lint error",
      failingHookName: "lint",
    },
  });
});

test("system stop_hook_summary with no errors and no prevention is dropped", () => {
  const line = JSON.stringify({
    type: "system",
    subtype: "stop_hook_summary",
    hookCount: 2,
    hookErrors: [],
    preventedContinuation: false,
  });
  expect(tailer.parseLine(line)).toEqual([]);
});

test("system entries with other subtypes are ignored", () => {
  const line = JSON.stringify({
    type: "system",
    subtype: "turn_duration",
    durationMs: 2300,
  });
  expect(tailer.parseLine(line)).toEqual([]);
});
```

- [ ] **Step 2: Confirm failure**

Run: `bun test src/__tests__/tailer.test.ts -t "stop_hook_summary\\|system entries" 2>&1 | tail -10`
Expected: first 2 tests fail; the 3rd may already pass since unknown system types fall through.

- [ ] **Step 3: Implement**

In `src/sessions/tailer.ts` `parseLine`, after the `permission-mode` branch added in Task 2, add:

```ts
if (entry.type === "system" && entry.subtype === "stop_hook_summary") {
  const hookCount = Number(entry.hookCount) || 0;
  const errorCount = Array.isArray(entry.hookErrors)
    ? entry.hookErrors.length
    : 0;
  const preventedContinuation = Boolean(entry.preventedContinuation);
  if (errorCount === 0 && !preventedContinuation) return [];
  const firstError =
    errorCount > 0
      ? String(entry.hookErrors[0]?.error ?? entry.hookErrors[0] ?? "")
      : undefined;
  const failingHookName =
    errorCount > 0 ? String(entry.hookErrors[0]?.name ?? "") : undefined;
  return [
    {
      type: "hook_summary",
      content: firstError ?? `${hookCount} hook(s) ran`,
      hook: {
        hookCount,
        errorCount,
        preventedContinuation,
        firstError,
        failingHookName,
      },
    },
  ];
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/tailer.test.ts 2>&1 | tail -8`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/tailer.ts src/__tests__/tailer.test.ts
git commit -m "feat(tailer): emit hook_summary events from system stop_hook_summary entries

Suppresses the no-error/no-prevention case to avoid noise. Other system
subtypes (e.g. turn_duration) continue to be ignored."
```

---

## Task 4: Tailer extracts `tool_result` blocks from user-message content

**Files:**

- Modify: `src/sessions/tailer.ts` — user-message branch in `parseLine`; add `extractToolResultText` helper.
- Test: `src/__tests__/tailer.test.ts`.

Today: when a user entry's content is `[{type:"tool_result", ...}]`-only, `extractUserText` returns null and parseLine emits `[]`. New behaviour: emit one `tool_result` event per `tool_result` block.

- [ ] **Step 1: Write failing tests**

```ts
test("user message with single tool_result emits tool_result event", () => {
  const line = JSON.stringify({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_123",
          content: "file contents here",
          is_error: false,
        },
      ],
    },
  });
  const events = tailer.parseLine(line);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "tool_result",
    content: "file contents here",
    toolUseId: "tu_123",
    isError: false,
  });
});

test("user message with tool_result whose content is a block array flattens text", () => {
  const line = JSON.stringify({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_456",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
          is_error: true,
        },
      ],
    },
  });
  const events = tailer.parseLine(line);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "tool_result",
    content: "first\nsecond",
    toolUseId: "tu_456",
    isError: true,
  });
});

test("user message with multiple tool_result blocks emits one event per block", () => {
  const line = JSON.stringify({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "a", content: "one" },
        { type: "tool_result", tool_use_id: "b", content: "two" },
      ],
    },
  });
  const events = tailer.parseLine(line);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    type: "tool_result",
    toolUseId: "a",
    content: "one",
  });
  expect(events[1]).toMatchObject({
    type: "tool_result",
    toolUseId: "b",
    content: "two",
  });
});

test("tool_result without tool_use_id is dropped", () => {
  const line = JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", content: "orphan" }],
    },
  });
  expect(tailer.parseLine(line)).toEqual([]);
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun test src/__tests__/tailer.test.ts -t "tool_result" 2>&1 | tail -10`
Expected: 4 fails — current parseLine emits `[]` for tool_result-only content.

- [ ] **Step 3: Add the helper at module scope**

In `src/sessions/tailer.ts`, near the existing `extractOriginChatFromTag` and `stripChannelTag` helpers, add:

```ts
/** Flatten a tool_result content (string or text-block array) into a single string. */
function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: { type?: string; text?: string }) =>
        b?.type === "text" && typeof b.text === "string" ? b.text : "",
      )
      .filter((t) => t.length > 0)
      .join("\n");
  }
  return "";
}
```

- [ ] **Step 4: Modify the user-message branch in parseLine**

Find the user-message branch (the one that calls `extractUserText`). The current code looks like (paraphrased — read first to confirm):

```ts
if (entry.type === "user") {
  const text = this.extractUserText(entry.message?.content);
  if (!text) return [];
  // ... existing channel-tag handling, command_match, and final fallback ...
}
```

The current `extractUserText` filters out tool_result-only content, returning null. We need to emit tool_result events BEFORE that filter swallows the entry. Add a tool_result extraction stanza at the very top of the user-message branch:

```ts
if (entry.type === "user") {
  // tool_result content blocks must be emitted before the text-extraction
  // path runs, since tool_result-only content yields no text and would be
  // dropped silently.
  const rawContent = entry.message?.content;
  if (Array.isArray(rawContent)) {
    const resultEvents: TailEvent[] = [];
    for (const block of rawContent as Array<{
      type?: string;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>) {
      if (block.type !== "tool_result") continue;
      const toolUseId = String(block.tool_use_id ?? "");
      if (!toolUseId) continue;
      resultEvents.push({
        type: "tool_result",
        content: extractToolResultText(block.content),
        toolUseId,
        isError: Boolean(block.is_error),
      });
    }
    if (resultEvents.length > 0) {
      // If the user content is purely tool_result blocks, return only the
      // result events. If it also contains text (rare; mixed-content users
      // exist when the user pasted a tool reply alongside text), fall
      // through after appending so the text path also runs.
      const onlyToolResults = (rawContent as Array<{ type?: string }>).every(
        (b) => b.type === "tool_result",
      );
      if (onlyToolResults) return resultEvents;
      // Mixed: emit results now and let the rest of the branch produce
      // any user-text events too.
      const text = this.extractUserText(rawContent);
      if (text) {
        // Reuse the existing user-text path inline so we don't duplicate it.
        if (text.includes(CHANNEL_RELAY_TAG)) {
          const originChat = extractOriginChatFromTag(text);
          const inner = stripChannelTag(text);
          resultEvents.push({ type: "turn_boundary", content: "" });
          if (inner) {
            resultEvents.push({
              type: "user",
              content: inner,
              originChat,
            });
          }
        } else {
          resultEvents.push({ type: "user", content: text });
        }
      }
      return resultEvents;
    }
  }

  // ... existing branch continues unchanged from here ...
  const text = this.extractUserText(entry.message?.content);
  if (!text) return [];
  if (text.includes(CHANNEL_RELAY_TAG)) { ... }
  // etc.
}
```

Read the actual current branch first (`grep -n 'entry.type === "user"' src/sessions/tailer.ts` and read 25 lines around it) to make sure the structural edits don't drop existing logic. The "..." continuations above mean "the existing branch as-is".

- [ ] **Step 5: Run tests**

Run: `bun test src/__tests__/tailer.test.ts 2>&1 | tail -8`
Expected: all pass.

- [ ] **Step 6: Full backend isolated suite**

Run: `bun run test 2>&1 | awk '/^ +[0-9]+ pass$/{p+=$1} /^ +[0-9]+ fail$/{f+=$1} END{print "pass="p" fail="f}'`
Expected: `fail=0`. Watch for regressions in `web-sessions-history.test.ts` (it asserts `tool_result` blocks are skipped — Task 7 will update it; for now the assertion of `events.toEqual([])` for tool_result-only content should still hold since web/sessions/history.ts is independent of tailer.ts).

- [ ] **Step 7: Commit**

```bash
git add src/sessions/tailer.ts src/__tests__/tailer.test.ts
git commit -m "feat(tailer): emit tool_result events instead of dropping the JSONL block

Each tool_result block becomes a TailEvent with toolUseId, content, and
isError. Mixed user content (tool_result + text) now emits both the
result events and the text events; pure tool_result content yields only
result events."
```

---

## Task 5: SSE bridge forwards three new event types

**Files:**

- Modify: `src/handlers/watch.ts` — `bridgeTailToSse` function.
- Modify: `src/web/sse.ts` — `SseEvent` interface.
- Test: `src/__tests__/sse-bridge.test.ts`.

- [ ] **Step 1: Extend `SseEvent` shape**

In `src/web/sse.ts`, replace the existing `SseEvent` interface with:

```ts
export interface SseEvent {
  type:
    | "text"
    | "tool"
    | "thinking"
    | "segment_end"
    | "done"
    | "send_file"
    | "tool_result"
    | "permission_mode"
    | "hook_summary";
  content: string;
  segmentId?: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  isError?: boolean;
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  hook?: {
    hookCount: number;
    errorCount: number;
    preventedContinuation: boolean;
    firstError?: string;
    failingHookName?: string;
  };
}
```

- [ ] **Step 2: Write failing tests**

In `src/__tests__/sse-bridge.test.ts`, append inside the `describe("bridgeTailToSse", …)` block:

```ts
test("tool_result event maps to SseEvent with toolUseId and isError", () => {
  const e: TailEvent = {
    type: "tool_result",
    content: "exit 0",
    toolUseId: "tu_1",
    isError: false,
  };
  bridgeTailToSse(bus, SID, e);
  expect(emitted).toHaveLength(1);
  expect(emitted[0]!.event).toMatchObject({
    type: "tool_result",
    content: "exit 0",
    toolUseId: "tu_1",
    isError: false,
  });
});

test("permission_mode event maps to SseEvent with permissionMode", () => {
  const e: TailEvent = {
    type: "permission_mode",
    content: "plan",
    permissionMode: "plan",
  };
  bridgeTailToSse(bus, SID, e);
  expect(emitted).toHaveLength(1);
  expect(emitted[0]!.event).toMatchObject({
    type: "permission_mode",
    permissionMode: "plan",
  });
});

test("hook_summary event maps to SseEvent with hook payload", () => {
  const e: TailEvent = {
    type: "hook_summary",
    content: "lint failed",
    hook: {
      hookCount: 1,
      errorCount: 1,
      preventedContinuation: true,
      firstError: "lint failed",
      failingHookName: "lint",
    },
  };
  bridgeTailToSse(bus, SID, e);
  expect(emitted).toHaveLength(1);
  expect(emitted[0]!.event).toMatchObject({
    type: "hook_summary",
    content: "lint failed",
    hook: {
      errorCount: 1,
      preventedContinuation: true,
      failingHookName: "lint",
    },
  });
});
```

- [ ] **Step 3: Run, confirm failure**

Run: `bun test src/__tests__/sse-bridge.test.ts 2>&1 | tail -8`
Expected: 3 new tests fail (switch falls through; nothing emitted).

- [ ] **Step 4: Extend `bridgeTailToSse`**

In `src/handlers/watch.ts`, locate `bridgeTailToSse`. Add three new cases inside the switch (after the existing `case "turn_boundary"` and before the closing brace):

```ts
case "tool_result":
  bus.emit(sessionId, {
    type: "tool_result",
    content: event.content,
    toolUseId: event.toolUseId,
    isError: event.isError,
  });
  return;
case "permission_mode":
  bus.emit(sessionId, {
    type: "permission_mode",
    content: event.permissionMode ?? "",
    permissionMode: event.permissionMode,
  });
  return;
case "hook_summary":
  bus.emit(sessionId, {
    type: "hook_summary",
    content: event.content,
    hook: event.hook,
  });
  return;
```

- [ ] **Step 5: Run tests**

Run: `bun test src/__tests__/sse-bridge.test.ts 2>&1 | tail -6`
Expected: all 10 tests pass (7 existing + 3 new).

- [ ] **Step 6: Typecheck and full suite**

Run:

```bash
bunx tsc --noEmit -p .
bun run test 2>&1 | awk '/^ +[0-9]+ pass$/{p+=$1} /^ +[0-9]+ fail$/{f+=$1} END{print "pass="p" fail="f}'
```

Expected: tsc exit 0; `fail=0`.

- [ ] **Step 7: Commit**

```bash
git add src/web/sse.ts src/handlers/watch.ts src/__tests__/sse-bridge.test.ts
git commit -m "feat(sse): bridge tool_result, permission_mode, hook_summary events to web

Extends SseEvent shape with the new field set required by each type and
adds three new switch cases in bridgeTailToSse that map each TailEvent
1:1 onto an SseEvent."
```

---

## Task 6: Web history replay surfaces the new event types

**Files:**

- Modify: `src/web/sessions/history.ts` — extend `mapUserEntry` (handle tool_result) and `readSessionHistory` (handle top-level permission-mode + system).
- Test: `src/__tests__/web-sessions-history.test.ts`.

- [ ] **Step 1: Read current shape**

Run: `sed -n '20,80p' src/web/sessions/history.ts`
Expected: see the existing `mapUserEntry`, `mapAssistantEntry`, and `readSessionHistory`.

- [ ] **Step 2: Write failing tests**

Append to `src/__tests__/web-sessions-history.test.ts` inside the `describe("readSessionHistory", …)` block:

```ts
test("tool_result content blocks surface as tool_result SseEvents", async () => {
  const sid = "sid-tool-result";
  writeFixture(sid, [
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_xyz",
            content: "120 lines",
            is_error: false,
          },
        ],
      },
    },
  ]);
  const { readSessionHistory } = await load();
  const events = await readSessionHistory(sid, 100);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "tool_result",
    content: "120 lines",
    toolUseId: "tu_xyz",
    isError: false,
  });
});

test("permission-mode top-level entry surfaces as permission_mode SseEvent", async () => {
  const sid = "sid-perm-mode";
  writeFixture(sid, [
    {
      type: "permission-mode",
      permissionMode: "plan",
      sessionId: sid,
    },
  ]);
  const { readSessionHistory } = await load();
  const events = await readSessionHistory(sid, 100);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "permission_mode",
    permissionMode: "plan",
  });
});

test("system stop_hook_summary with errors surfaces as hook_summary SseEvent", async () => {
  const sid = "sid-hook";
  writeFixture(sid, [
    {
      type: "system",
      subtype: "stop_hook_summary",
      hookCount: 1,
      hookErrors: [{ name: "lint", error: "boom" }],
      preventedContinuation: true,
    },
  ]);
  const { readSessionHistory } = await load();
  const events = await readSessionHistory(sid, 100);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "hook_summary",
    content: "boom",
    hook: {
      errorCount: 1,
      preventedContinuation: true,
      failingHookName: "lint",
    },
  });
});

test("system stop_hook_summary without errors is dropped", async () => {
  const sid = "sid-hook-clean";
  writeFixture(sid, [
    {
      type: "system",
      subtype: "stop_hook_summary",
      hookCount: 1,
      hookErrors: [],
      preventedContinuation: false,
    },
  ]);
  const { readSessionHistory } = await load();
  const events = await readSessionHistory(sid, 100);
  expect(events).toEqual([]);
});
```

Also: locate the existing test `"skips user tool_result messages"` and DELETE it (the new behaviour replaces it — tool_result is no longer skipped in history).

- [ ] **Step 3: Confirm failure**

Run: `bun test src/__tests__/web-sessions-history.test.ts 2>&1 | tail -10`
Expected: new tests fail; the old "skips user tool_result messages" assertion should already be removed.

- [ ] **Step 4: Implement helper + extend `mapUserEntry`**

In `src/web/sessions/history.ts`, add a helper at the top of the file (after the imports):

```ts
function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: { type?: string; text?: string }) =>
        b?.type === "text" && typeof b.text === "string" ? b.text : "",
      )
      .filter((t) => t.length > 0)
      .join("\n");
  }
  return "";
}
```

Then locate `mapUserEntry`. The current loop iterates content blocks for text; comment `// tool_result intentionally skipped` is the line to remove. Replace the loop body so tool_result blocks emit events too:

```ts
function mapUserEntry(entry: JsonlEntry): SseEvent[] {
  // ... preserve the existing channel-tag handling at the top ...
  if (!Array.isArray(content)) return [];
  const events: SseEvent[] = [];
  for (const block of content as Array<{
    type?: string;
    text?: string;
    tool_use_id?: string;
    content?: unknown;
    is_error?: boolean;
  }>) {
    if (block.type === "text" && typeof block.text === "string") {
      const ev = classifyUserText(block.text);
      if (ev) events.push(ev);
    } else if (block.type === "tool_result") {
      const toolUseId = String(block.tool_use_id ?? "");
      if (!toolUseId) continue;
      events.push({
        type: "tool_result",
        content: extractToolResultText(block.content),
        toolUseId,
        isError: Boolean(block.is_error),
      });
    }
  }
  return events;
}
```

(Read the actual current `mapUserEntry` first and preserve the channel-tag-handling, string-content branch, etc. Only the inner block loop changes.)

- [ ] **Step 5: Implement top-level handlers in `readSessionHistory`**

Locate `readSessionHistory`. Find the dispatch (e.g. `if (entry.type === "user") { ... } else if (entry.type === "assistant") { ... }`). Add two new branches:

```ts
} else if (entry.type === "permission-mode") {
  const mode = (entry as { permissionMode?: unknown }).permissionMode;
  if (typeof mode === "string") {
    all.push({
      type: "permission_mode",
      content: mode,
      permissionMode: mode as SseEvent["permissionMode"],
    });
  }
} else if (entry.type === "system") {
  const sub = (entry as { subtype?: string }).subtype;
  if (sub === "stop_hook_summary") {
    const e = entry as {
      hookCount?: number;
      hookErrors?: Array<{ name?: string; error?: string }>;
      preventedContinuation?: boolean;
    };
    const errors = Array.isArray(e.hookErrors) ? e.hookErrors : [];
    const preventedContinuation = Boolean(e.preventedContinuation);
    if (errors.length > 0 || preventedContinuation) {
      all.push({
        type: "hook_summary",
        content: errors[0]?.error ?? `${e.hookCount ?? 0} hook(s) ran`,
        hook: {
          hookCount: e.hookCount ?? 0,
          errorCount: errors.length,
          preventedContinuation,
          firstError: errors[0]?.error,
          failingHookName: errors[0]?.name,
        },
      });
    }
  }
}
```

The `JsonlEntry` interface in this file may need a couple of optional fields. Read the file's interface definitions and extend them as needed (keep optional + permissive — `unknown` for raw fields, narrow at use site).

- [ ] **Step 6: Run tests**

Run: `bun test src/__tests__/web-sessions-history.test.ts 2>&1 | tail -10`
Expected: all pass.

- [ ] **Step 7: Typecheck + full suite**

```bash
bunx tsc --noEmit -p .
bun run test 2>&1 | awk '/^ +[0-9]+ pass$/{p+=$1} /^ +[0-9]+ fail$/{f+=$1} END{print "pass="p" fail="f}'
```

Expected: tsc exit 0; `fail=0`.

- [ ] **Step 8: Commit**

```bash
git add src/web/sessions/history.ts src/__tests__/web-sessions-history.test.ts
git commit -m "feat(web/history): surface tool_result, permission_mode, hook_summary in replay

mapUserEntry now emits tool_result events for tool_result content blocks
(previously dropped). readSessionHistory now handles top-level
permission-mode and system stop_hook_summary entries. Preserves the
existing convention of dropping clean stop_hook_summary entries."
```

---

## Task 7: Web `api.ts` mirrors the SseEvent extension

**Files:**

- Modify: `web/src/api.ts` — `SseEvent` type.

- [ ] **Step 1: Read current shape**

Run: `grep -n "SseEvent" web/src/api.ts`
Expected: an `interface SseEvent` definition.

- [ ] **Step 2: Replace the interface**

In `web/src/api.ts`, replace the `SseEvent` interface with:

```ts
export interface SseEvent {
  type:
    | "text"
    | "tool"
    | "thinking"
    | "segment_end"
    | "done"
    | "send_file"
    | "tool_result"
    | "permission_mode"
    | "hook_summary";
  content: string;
  segmentId?: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  isError?: boolean;
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  hook?: {
    hookCount: number;
    errorCount: number;
    preventedContinuation: boolean;
    firstError?: string;
    failingHookName?: string;
  };
}
```

- [ ] **Step 3: Typecheck frontend**

Run: `cd web && bunx tsc --noEmit && cd ..`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add web/src/api.ts
git commit -m "feat(web): mirror SseEvent shape on the client side"
```

---

## Task 8: `ToolBlock` accepts `result` prop and renders coloured bullet

**Files:**

- Modify: `web/src/components/Terminal.tsx` — `ToolBlock` props + bullet colour.
- Test: `web/src/__tests__/Terminal.test.tsx`.

- [ ] **Step 1: Write failing tests**

Append to `web/src/__tests__/Terminal.test.tsx` inside the existing `describe("Terminal", …)` block:

```tsx
test("ToolBlock with successful result renders a green bullet", () => {
  const events: SseEvent[] = [
    {
      type: "tool",
      content: "Reading foo.ts",
      toolName: "Read",
      toolInput: { file_path: "/foo.ts" },
      toolUseId: "tu_a",
    },
    {
      type: "tool_result",
      content: "ok",
      toolUseId: "tu_a",
      isError: false,
    },
  ];
  const { container } = render(<Terminal events={events} streaming={false} />);
  const bullet = container.querySelector(".text-green-400");
  expect(bullet).not.toBeNull();
});

test("ToolBlock with error result renders a red bullet", () => {
  const events: SseEvent[] = [
    {
      type: "tool",
      content: "Reading foo.ts",
      toolName: "Read",
      toolInput: { file_path: "/foo.ts" },
      toolUseId: "tu_b",
    },
    {
      type: "tool_result",
      content: "ENOENT",
      toolUseId: "tu_b",
      isError: true,
    },
  ];
  const { container } = render(<Terminal events={events} streaming={false} />);
  expect(container.querySelector(".text-red-400")).not.toBeNull();
});
```

These reference `events` containing both a tool and a tool_result with matching `toolUseId`. The implementation must correlate them.

- [ ] **Step 2: Run, confirm failure**

Run: `cd web && bun run test 2>&1 | tail -10 && cd ..`
Expected: 2 tests fail (no green/red bullets currently — bullet is `text-terminal-muted`).

- [ ] **Step 3: Add `toolUseId` to `tool` event mapping in tailer (already done in Task 6 for history; now confirm bridge)**

Quick confirmation step — `tool` events do NOT currently carry `toolUseId`. The tailer's tool branch needs to include it so the client can correlate. In `src/sessions/tailer.ts`, find the existing `tool_use` handling block (where `events.push({ type: "tool", content, toolName, toolInput })` lives). Modify it to also include `toolUseId: block.id`:

```ts
events.push({
  type: "tool",
  content: toolDisplay,
  toolName: block.name,
  toolInput: input,
  toolUseId: block.id,
});
```

Same for `bridgeTailToSse` `case "tool"` and `web/sessions/history.ts mapAssistantEntry tool branch`. Each should set `toolUseId` on the emitted event. Read each and add the field.

For the SseEvent type mapping in bridge `case "tool"`:

```ts
case "tool":
  bus.emit(sessionId, {
    type: "tool",
    content: event.content,
    toolName: event.toolName,
    toolInput: event.toolInput,
    toolUseId: event.toolUseId,
  });
  return;
```

For `web/sessions/history.ts mapAssistantEntry`:

```ts
} else if (raw.type === "tool_use" && raw.name) {
  const input = (raw.input ?? {}) as Record<string, unknown>;
  // ... existing channel-relay-reply branch ...
  } else if (raw.name !== "mcp__channel-relay__react") {
    events.push({
      type: "tool",
      content: formatToolStatus(raw.name, input),
      toolName: raw.name,
      toolInput: input,
      toolUseId: typeof raw.id === "string" ? raw.id : undefined,
    });
  }
}
```

You'll need to add `id?: string` to the `AssistantBlock` interface near the top of `web/sessions/history.ts`.

- [ ] **Step 4: Modify `ToolBlock` in Terminal.tsx to accept and render result-driven bullet**

In `web/src/components/Terminal.tsx`, update the `ToolBlock` signature and the bullet rendering:

```tsx
function ToolBlock({
  name,
  input,
  result,
}: {
  name: string;
  input: Record<string, unknown>;
  result?: { content: string; isError: boolean };
}) {
  const header = clampHeader(/* ... existing logic unchanged ... */);
  const body = (() => {
    /* ... existing logic unchanged ... */
  })();

  // Bullet colour reflects result state:
  // - no result → muted (in-flight or unresolved)
  // - success → green
  // - error → red
  const bulletCls = result
    ? result.isError
      ? "text-red-400"
      : "text-green-400"
    : "text-terminal-muted";

  return (
    <div className="my-1 border-l-2 border-terminal-muted/40 pl-2">
      <div className="font-mono text-xs text-terminal-green">
        <span className={bulletCls}>●</span> {header}
      </div>
      {body && <div className="mt-1">{body}</div>}
    </div>
  );
}
```

- [ ] **Step 5: Correlate results in the `Terminal` render loop**

In `Terminal`, before iterating events build a `Map<string, ToolResult>`:

```tsx
export function Terminal({ events, streaming }: TerminalProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  const toggle = (ti: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(ti)) next.delete(ti);
      else next.add(ti);
      return next;
    });

  // Correlate tool_result events to their originating tool_use by toolUseId.
  // Both are SSE events; the client owns this stitching.
  const resultByToolUseId = new Map<
    string,
    { content: string; isError: boolean }
  >();
  for (const evt of events) {
    if (evt.type === "tool_result" && evt.toolUseId) {
      resultByToolUseId.set(evt.toolUseId, {
        content: evt.content,
        isError: Boolean(evt.isError),
      });
    }
  }

  const turns = groupIntoTurns(events);

  // ... existing render loop unchanged below ...
}
```

Then in `renderEventBody`, pass the looked-up result into ToolBlock:

```tsx
function renderEventBody(
  evt: SseEvent,
  key: number,
  resultByToolUseId: Map<string, { content: string; isError: boolean }>,
) {
  if (evt.type === "tool" && evt.toolName) {
    if (SUPPRESSED_TOOLS.has(evt.toolName)) return null;
    const result = evt.toolUseId
      ? resultByToolUseId.get(evt.toolUseId)
      : undefined;
    return (
      <ToolBlock
        key={key}
        name={evt.toolName}
        input={evt.toolInput ?? {}}
        result={result}
      />
    );
  }
  // ... rest unchanged ...
}
```

The call site of `renderEventBody` (inside `Terminal`'s map) must now pass `resultByToolUseId` as a third arg. Find the call site (`turn.items.map(({ evt, idx }) => renderEventBody(evt, idx))`) and add the map.

Also: in `groupIntoTurns`, ensure `tool_result` events are skipped when building turns (they're metadata, not visible blocks):

```ts
function groupIntoTurns(events: SseEvent[]): Turn[] {
  const turns: Turn[] = [];
  events.forEach((evt, idx) => {
    if (evt.type === "segment_end" || evt.type === "done") return;
    if (evt.type === "tool_result") return; // correlated to tool, not rendered as own row
    if (evt.type === "permission_mode") return; // rendered as banner above
    if (evt.type === "hook_summary") return; // rendered as inline card (Task 10)
    if (evt.type === "tool" && SUPPRESSED_TOOLS.has(evt.toolName ?? "")) return;
    // ... rest unchanged ...
  });
  return turns;
}
```

- [ ] **Step 6: Run tests**

Run: `cd web && bun run test 2>&1 | tail -8 && cd ..`
Expected: all 28+ tests pass (26 prior + 2 new for green/red bullets).

- [ ] **Step 7: Typecheck**

Run: `cd web && bunx tsc --noEmit && cd ..`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/sessions/tailer.ts src/handlers/watch.ts src/web/sessions/history.ts web/src/components/Terminal.tsx web/src/__tests__/Terminal.test.tsx
git commit -m "feat(web): correlate tool_result to tool_use; recolour bullet by status

ToolBlock now accepts an optional result prop. The bullet renders
muted when unresolved, green on success, red on error. Terminal
builds a Map<toolUseId, result> from the event stream and passes
the matching entry to each tool block. tool_result/permission_mode/
hook_summary events are excluded from turn grouping (they're
correlated to other components, not standalone rows)."
```

---

## Task 9: Per-tool result body rendering (`ToolResultBody`)

**Files:**

- Modify: `web/src/components/Terminal.tsx` — add `ToolResultBody` sub-component, render it inside `ToolBlock` body.
- Test: `web/src/__tests__/Terminal.test.tsx`.

The promotion list (per spec): on success, render rich body for `Bash`, `Grep`, `Glob`, `Task`, `Agent`, `WebFetch`, `WebSearch`. Always render error message body (any tool).

- [ ] **Step 1: Write failing tests**

```tsx
test("Bash success result shows last 5 lines and +N indicator", () => {
  const longOutput = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );
  const events: SseEvent[] = [
    {
      type: "tool",
      content: "Bash(ls)",
      toolName: "Bash",
      toolInput: { command: "ls" },
      toolUseId: "tu_bash",
    },
    {
      type: "tool_result",
      content: longOutput,
      toolUseId: "tu_bash",
      isError: false,
    },
  ];
  const { container } = render(<Terminal events={events} streaming={false} />);
  expect(container.textContent).toContain("line 12");
  expect(container.textContent).toContain("line 8");
  expect(container.textContent).not.toContain("line 1\n");
  expect(container.textContent).toMatch(/\+7 lines/);
});

test("Grep success result shows match count summary", () => {
  const grepOutput = "src/a.ts: 3 matches\nsrc/b.ts: 1 match\n";
  const events: SseEvent[] = [
    {
      type: "tool",
      content: 'Grep("foo")',
      toolName: "Grep",
      toolInput: { pattern: "foo" },
      toolUseId: "tu_grep",
    },
    {
      type: "tool_result",
      content: grepOutput,
      toolUseId: "tu_grep",
      isError: false,
    },
  ];
  const { container } = render(<Terminal events={events} streaming={false} />);
  expect(container.textContent).toMatch(/Found .* matches/i);
});

test("Read success result renders no body (suppressed on success)", () => {
  const events: SseEvent[] = [
    {
      type: "tool",
      content: "Read(foo.ts)",
      toolName: "Read",
      toolInput: { file_path: "/foo.ts" },
      toolUseId: "tu_r",
    },
    {
      type: "tool_result",
      content: "<file contents 100 lines>",
      toolUseId: "tu_r",
      isError: false,
    },
  ];
  const { container } = render(<Terminal events={events} streaming={false} />);
  // bullet should be green; body should NOT contain the file contents
  expect(container.querySelector(".text-green-400")).not.toBeNull();
  expect(container.textContent).not.toContain("<file contents");
});

test("any tool with error result shows error message body", () => {
  const events: SseEvent[] = [
    {
      type: "tool",
      content: "Read(foo.ts)",
      toolName: "Read",
      toolInput: { file_path: "/foo.ts" },
      toolUseId: "tu_err",
    },
    {
      type: "tool_result",
      content: "ENOENT: no such file or directory",
      toolUseId: "tu_err",
      isError: true,
    },
  ];
  const { container } = render(<Terminal events={events} streaming={false} />);
  expect(container.textContent).toContain("ENOENT");
});
```

- [ ] **Step 2: Confirm failure**

Run: `cd web && bun run test -t "Bash success\\|Grep success\\|Read success\\|tool with error" 2>&1 | tail -15 && cd ..`
Expected: 4 tests fail.

- [ ] **Step 3: Implement `ToolResultBody` and integrate**

In `web/src/components/Terminal.tsx`, add a new component just above `ToolBlock`:

```tsx
const PROMOTE_ON_SUCCESS = new Set([
  "Bash",
  "Grep",
  "Glob",
  "Task",
  "Agent",
  "WebFetch",
  "WebSearch",
]);

function ToolResultBody({
  name,
  result,
}: {
  name: string;
  result: { content: string; isError: boolean };
}) {
  // Errors always render — first 200 chars in red.
  if (result.isError) {
    const msg = result.content.slice(0, 200);
    return (
      <pre className="font-mono text-[11px] leading-snug whitespace-pre-wrap break-all m-0 bg-red-950/40 text-red-300 p-1 rounded">
        {msg || "(no error message)"}
      </pre>
    );
  }

  // Success bodies: only render for promoted tools.
  if (!PROMOTE_ON_SUCCESS.has(name)) return null;

  if (name === "Bash") {
    const lines = result.content.split("\n");
    const tail = lines.slice(-5);
    const more = lines.length > 5 ? `\n+${lines.length - 5} lines` : "";
    return (
      <pre className="font-mono text-[11px] leading-snug whitespace-pre-wrap break-all m-0 bg-terminal-bg/60 text-terminal-text p-1 rounded">
        {tail.join("\n") + more}
      </pre>
    );
  }

  if (name === "Grep" || name === "Glob") {
    const lineCount = result.content.split("\n").filter((l) => l.trim()).length;
    const label = name === "Grep" ? "matches" : "files";
    return (
      <div className="text-[11px] text-terminal-muted italic">
        Found {lineCount} {label}
      </div>
    );
  }

  if (name === "Task" || name === "Agent") {
    // Try to parse "tool uses · tokens · elapsed" out of the result text.
    // Fall back to a generic "Done" line if not present.
    const m = result.content.match(
      /(\d+)\s*tool[_\s]?uses?.*?([\d.]+k?)\s*tokens?.*?([\d.]+s)/i,
    );
    return (
      <div className="text-[11px] text-terminal-muted italic">
        {m ? `Done · ${m[1]} tools · ${m[2]} tokens · ${m[3]}` : "Done"}
      </div>
    );
  }

  if (name === "WebFetch" || name === "WebSearch") {
    const len = result.content.length;
    return (
      <div className="text-[11px] text-terminal-muted italic">
        {len.toLocaleString()} chars returned
      </div>
    );
  }

  return null;
}
```

Then update `ToolBlock` to render `ToolResultBody` after the existing per-tool body:

```tsx
return (
  <div className="my-1 border-l-2 border-terminal-muted/40 pl-2">
    <div className="font-mono text-xs text-terminal-green">
      <span className={bulletCls}>●</span> {header}
    </div>
    {body && <div className="mt-1">{body}</div>}
    {result && (
      <div className="mt-1">
        <ToolResultBody name={name} result={result} />
      </div>
    )}
  </div>
);
```

- [ ] **Step 4: Run tests**

Run: `cd web && bun run test 2>&1 | tail -6 && cd ..`
Expected: all pass.

- [ ] **Step 5: Typecheck and rebuild bundle**

```bash
cd web && bunx tsc --noEmit && bun run build && cd ..
```

Expected: tsc exit 0; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Terminal.tsx web/src/__tests__/Terminal.test.tsx web/dist
git commit -m "feat(web): per-tool result body rendering

Bash → last 5 lines + +N indicator. Grep/Glob → match/file count.
Task/Agent → parsed Done line. WebFetch/WebSearch → byte count.
Read/Write/Edit/MultiEdit/MCP/Skill → success body suppressed (call
alone is informative). Errors → first 200 chars rendered for any tool."
```

---

## Task 10: `PermissionModeBanner` and `HookSummaryCard`

**Files:**

- Modify: `web/src/components/Terminal.tsx` — add two new components; render them at the top of the Terminal viewport.
- Test: `web/src/__tests__/Terminal.test.tsx`.

- [ ] **Step 1: Write failing tests**

```tsx
test("permission_mode plan shows yellow banner", () => {
  const events: SseEvent[] = [
    { type: "permission_mode", content: "plan", permissionMode: "plan" },
  ];
  const { container } = render(<Terminal events={events} streaming={false} />);
  expect(container.textContent).toMatch(/Plan mode/i);
});

test("permission_mode default shows no banner", () => {
  const events: SseEvent[] = [
    { type: "permission_mode", content: "default", permissionMode: "default" },
  ];
  const { container } = render(<Terminal events={events} streaming={false} />);
  expect(container.textContent).not.toMatch(/Plan mode|Auto-accept|Bypass/i);
});

test("most recent permission_mode wins (later events override earlier)", () => {
  const events: SseEvent[] = [
    { type: "permission_mode", content: "plan", permissionMode: "plan" },
    { type: "permission_mode", content: "default", permissionMode: "default" },
  ];
  const { container } = render(<Terminal events={events} streaming={false} />);
  expect(container.textContent).not.toMatch(/Plan mode/i);
});

test("hook_summary renders as inline card with hook name and error", () => {
  const events: SseEvent[] = [
    {
      type: "hook_summary",
      content: "lint failed",
      hook: {
        hookCount: 1,
        errorCount: 1,
        preventedContinuation: true,
        firstError: "lint failed",
        failingHookName: "lint",
      },
    },
  ];
  const { container } = render(<Terminal events={events} streaming={false} />);
  expect(container.textContent).toContain("lint");
  expect(container.textContent).toContain("lint failed");
});
```

- [ ] **Step 2: Confirm failure**

Run: `cd web && bun run test -t "permission_mode\\|hook_summary" 2>&1 | tail -10 && cd ..`
Expected: 4 tests fail (no banner / card components exist).

- [ ] **Step 3: Add `PermissionModeBanner` and `HookSummaryCard`**

In `web/src/components/Terminal.tsx`, add two new components at module scope (above `Terminal`):

```tsx
function PermissionModeBanner({ events }: { events: SseEvent[] }) {
  // Find the latest permission_mode event in the stream.
  let latest: SseEvent["permissionMode"] | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "permission_mode") {
      latest = e.permissionMode;
      break;
    }
  }
  if (!latest || latest === "default") return null;
  const labels: Record<string, { text: string; cls: string }> = {
    plan: {
      text: "📋 Plan mode — agent will not modify files",
      cls: "bg-yellow-500/15 border-yellow-400/40 text-yellow-300",
    },
    acceptEdits: {
      text: "✅ Auto-accept edits",
      cls: "bg-green-500/15 border-green-400/40 text-green-300",
    },
    bypassPermissions: {
      text: "⚙ Bypass permissions",
      cls: "bg-terminal-muted/15 border-terminal-muted/40 text-terminal-muted",
    },
  };
  const conf = labels[latest];
  if (!conf) return null;
  return (
    <div className={`px-2 py-1 text-[11px] border ${conf.cls} rounded mb-2`}>
      {conf.text}
    </div>
  );
}

function HookSummaryCard({ event }: { event: SseEvent }) {
  if (event.type !== "hook_summary" || !event.hook) return null;
  const h = event.hook;
  return (
    <div className="my-2 px-2 py-1 border border-red-400/40 bg-red-950/30 rounded text-[11px]">
      <div className="text-red-300 font-semibold">
        🪝 stop hook
        {h.failingHookName ? ` ${h.failingHookName}` : ""}
        {h.preventedContinuation ? " blocked the run" : " failed"}
      </div>
      {h.firstError && (
        <div className="text-terminal-text mt-1 whitespace-pre-wrap">
          {h.firstError.slice(0, 200)}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Render the banner + cards from `Terminal`**

In `Terminal`'s return JSX, add the banner just inside the outer scroll div, and add hook_summary cards inline as their own pseudo-turns. Simplest approach: render the banner above the turns; render hook_summary cards as part of the events flow:

```tsx
return (
  <div className="flex-1 overflow-y-auto p-3 text-sm leading-snug">
    <PermissionModeBanner events={events} />
    {turns.map((turn, ti) => { /* ... existing ... */ })}
    {events
      .filter((e) => e.type === "hook_summary")
      .map((e, i) => (
        <HookSummaryCard key={`hook-${i}`} event={e} />
      ))}
    {streaming && (/* ... existing ... */)}
    <div ref={bottomRef} />
  </div>
);
```

(For correctness, hook_summary cards should appear _positionally_ in the event stream, not all bunched at the end. A more correct render would interleave them with turns. For the first cut, bunched-at-end is acceptable; refine in a follow-up if it matters.)

- [ ] **Step 5: Run tests**

Run: `cd web && bun run test 2>&1 | tail -6 && cd ..`
Expected: all pass.

- [ ] **Step 6: Typecheck + rebuild bundle**

```bash
cd web && bunx tsc --noEmit && bun run build && cd ..
```

- [ ] **Step 7: Commit**

```bash
git add web/src/components/Terminal.tsx web/src/__tests__/Terminal.test.tsx web/dist
git commit -m "feat(web): PermissionModeBanner + HookSummaryCard

Banner shows for plan/acceptEdits/bypassPermissions; default mode
renders no banner (the implicit norm). Hook_summary events render as
red inline cards with the failing hook name and first error message
(capped at 200 chars)."
```

---

## Task 11: Telegram `case "tool_result"` with selective promotion

**Files:**

- Modify: `src/handlers/watch.ts` — `WatchState` gains `toolUseRegistry`; `case "tool"` populates the registry; new `case "tool_result"` consults it.
- Modify: `src/formatting.ts` — new `formatToolResultSummary` helper.
- Test: `src/__tests__/watch.test.ts`.

- [ ] **Step 1: Write failing tests**

Append inside an appropriate describe block in `src/__tests__/watch.test.ts`:

```ts
describe("watch: handleTailEvent tool_result", () => {
  function makeMockApi() {
    const sent: Array<{ chatId: number | string; text: string }> = [];
    const api = {
      sendMessage: (chatId: number | string, text: string) => {
        sent.push({ chatId, text });
        return Promise.resolve({ message_id: 1 });
      },
      deleteMessage: () => Promise.resolve(true),
    } as unknown as Api;
    return { api, sent };
  }

  test("tool_result for Bash promotes (sends combined message)", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    // simulate the prior tool_use registering Bash for tu_x
    state.toolUseRegistry = new Map([["tu_x", "Bash"]]);
    handleTailEvent(
      api,
      state,
      {
        type: "tool_result",
        content: "out",
        toolUseId: "tu_x",
        isError: false,
      },
      6302,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Bash");
  });

  test("tool_result for Read does NOT send (ephemeral, suppressed)", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    state.toolUseRegistry = new Map([["tu_y", "Read"]]);
    handleTailEvent(
      api,
      state,
      {
        type: "tool_result",
        content: "file",
        toolUseId: "tu_y",
        isError: false,
      },
      6302,
    );
    expect(sent).toHaveLength(0);
  });

  test("tool_result with isError always promotes regardless of tool", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    state.toolUseRegistry = new Map([["tu_z", "Read"]]);
    handleTailEvent(
      api,
      state,
      {
        type: "tool_result",
        content: "ENOENT",
        toolUseId: "tu_z",
        isError: true,
      },
      6302,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("ENOENT");
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `bun test src/__tests__/watch.test.ts -t "tool_result" 2>&1 | tail -10`
Expected: 3 tests fail (no `case "tool_result"` exists).

- [ ] **Step 3: Add `formatToolResultSummary` to `src/formatting.ts`**

At the bottom of `src/formatting.ts` (after `formatToolStatus`):

```ts
/**
 * Format the combined "tool + result" message for Telegram. Called by the
 * Telegram watch handler when a tool_result arrives for a promoted tool
 * or any errored tool.
 */
export function formatToolResultSummary(
  toolName: string | undefined,
  resultContent: string,
  isError: boolean,
): string {
  const safeName = toolName ?? "tool";
  if (isError) {
    return `❌ <b>${escapeHtml(safeName)}</b>: ${escapeHtml(truncate(resultContent, 200))}`;
  }
  if (toolName === "Bash") {
    const lines = resultContent.split("\n");
    const lastLine = (lines[lines.length - 1] ?? "").trim();
    const more = lines.length > 1 ? ` (+${lines.length - 1} lines)` : "";
    return `▶️ <b>Bash</b>: ${code(truncate(lastLine, 80))}${more}`;
  }
  if (toolName === "Grep" || toolName === "Glob") {
    const count = resultContent.split("\n").filter((l) => l.trim()).length;
    const label = toolName === "Grep" ? "matches" : "files";
    return `🔎 <b>${toolName}</b>: ${count} ${label}`;
  }
  if (toolName === "Task" || toolName === "Agent") {
    const m = resultContent.match(
      /(\d+)\s*tool[_\s]?uses?.*?([\d.]+k?)\s*tokens?.*?([\d.]+s)/i,
    );
    return m
      ? `🎯 <b>${toolName} done</b>: ${m[1]} tools · ${m[2]} tokens · ${m[3]}`
      : `🎯 <b>${toolName} done</b>`;
  }
  if (toolName === "WebFetch" || toolName === "WebSearch") {
    return `🌐 <b>${toolName}</b>: ${resultContent.length.toLocaleString()} chars returned`;
  }
  // Unknown promoted tool: generic "done".
  return `✅ <b>${escapeHtml(safeName)}</b>: ${escapeHtml(truncate(resultContent, 80))}`;
}
```

- [ ] **Step 4: Extend WatchState and add registry population in `case "tool"`**

In `src/handlers/watch.ts`, find the `WatchState` (or `TailDisplayState`) interface and add:

```ts
toolUseRegistry?: Map<string, string>; // toolUseId → toolName
lastPermissionMode?: SseEvent["permissionMode"];
```

In the existing `case "tool"` block (just inside the case, before the suppression check), add:

```ts
case "tool": {
  // Register this tool_use so a later tool_result can look up its name.
  if (event.toolUseId && event.toolName) {
    if (!state.toolUseRegistry) state.toolUseRegistry = new Map();
    state.toolUseRegistry.set(event.toolUseId, event.toolName);
    // Bound the registry to last 100 entries to avoid unbounded growth
    // when a session has many tool calls without matching results.
    if (state.toolUseRegistry.size > 100) {
      const firstKey = state.toolUseRegistry.keys().next().value;
      if (firstKey !== undefined) state.toolUseRegistry.delete(firstKey);
    }
  }
  // ... existing suppression check + delete-and-resend logic unchanged ...
}
```

- [ ] **Step 5: Add `case "tool_result"`**

In the same switch as `case "tool"`, add a new case:

```ts
case "tool_result": {
  const toolName = state.toolUseRegistry?.get(event.toolUseId ?? "");
  const PROMOTE_ON_SUCCESS = new Set([
    "Bash", "Grep", "Glob", "Task", "Agent", "WebFetch", "WebSearch",
  ]);
  const shouldPromote =
    event.isError === true || PROMOTE_ON_SUCCESS.has(toolName ?? "");

  // Free the registry entry regardless of promotion decision.
  state.toolUseRegistry?.delete(event.toolUseId ?? "");

  if (!shouldPromote) break;

  // Promoted result: send a fresh message. Do NOT track as currentToolMsg
  // (so it survives the next text/tool delete), and do NOT add to
  // progressMessages (so resetDisplaySegment doesn't sweep it).
  const summary = formatToolResultSummary(
    toolName,
    event.content,
    Boolean(event.isError),
  );
  botApi
    .sendMessage(chatId, summary, { parse_mode: "HTML", ...threadOpts })
    .catch((err) => debug(`tail tool_result: ${err}`));
  break;
}
```

- [ ] **Step 6: Import the helper**

At the top of `src/handlers/watch.ts`, ensure the import line for `formatting` includes `formatToolResultSummary`. Run `grep "from \"../formatting\"" src/handlers/watch.ts` and add the symbol.

- [ ] **Step 7: Run tests**

Run: `bun test src/__tests__/watch.test.ts 2>&1 | tail -10`
Expected: all pass.

- [ ] **Step 8: Typecheck + full suite**

```bash
bunx tsc --noEmit -p .
bun run test 2>&1 | awk '/^ +[0-9]+ pass$/{p+=$1} /^ +[0-9]+ fail$/{f+=$1} END{print "pass="p" fail="f}'
```

Expected: tsc exit 0; `fail=0`.

- [ ] **Step 9: Commit**

```bash
git add src/handlers/watch.ts src/formatting.ts src/__tests__/watch.test.ts
git commit -m "feat(watch): Telegram case tool_result with selective promotion

WatchState gains toolUseRegistry (Map<toolUseId, toolName>) populated
when tool_use fires. case tool_result looks up the tool name and
promotes the result to a Telegram message only for Bash/Grep/Glob/
Task/Agent/WebFetch/WebSearch (success) or any tool (error). Promoted
messages are NOT tracked as currentToolMsg or in progressMessages so
they survive subsequent text streaming."
```

---

## Task 12: Telegram `case "permission_mode"` with dedup

**Files:**

- Modify: `src/handlers/watch.ts` — new case in `handleTailEvent`.
- Test: `src/__tests__/watch.test.ts`.

- [ ] **Step 1: Write failing tests**

```ts
describe("watch: handleTailEvent permission_mode", () => {
  function makeMockApi() {
    const sent: Array<{ chatId: number | string; text: string }> = [];
    const api = {
      sendMessage: (chatId: number | string, text: string) => {
        sent.push({ chatId, text });
        return Promise.resolve({ message_id: 1 });
      },
      deleteMessage: () => Promise.resolve(true),
    } as unknown as Api;
    return { api, sent };
  }

  test("first permission_mode emits a message", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    handleTailEvent(
      api,
      state,
      { type: "permission_mode", content: "plan", permissionMode: "plan" },
      6302,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Plan mode");
  });

  test("duplicate consecutive permission_mode is deduplicated", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    handleTailEvent(
      api,
      state,
      { type: "permission_mode", content: "plan", permissionMode: "plan" },
      6302,
    );
    handleTailEvent(
      api,
      state,
      { type: "permission_mode", content: "plan", permissionMode: "plan" },
      6302,
    );
    expect(sent).toHaveLength(1);
  });

  test("permission_mode default is not emitted as a message", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    handleTailEvent(
      api,
      state,
      {
        type: "permission_mode",
        content: "default",
        permissionMode: "default",
      },
      6302,
    );
    expect(sent).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `bun test src/__tests__/watch.test.ts -t "permission_mode" 2>&1 | tail -10`
Expected: 3 fails.

- [ ] **Step 3: Add `case "permission_mode"`**

In `src/handlers/watch.ts` `handleTailEvent`, add:

```ts
case "permission_mode": {
  const mode = event.permissionMode;
  if (!mode || mode === "default") break;
  if (state.lastPermissionMode === mode) break; // dedup
  state.lastPermissionMode = mode;
  const labels: Record<string, string> = {
    plan: "Plan mode on",
    acceptEdits: "Auto-accept on",
    bypassPermissions: "Bypass permissions on",
  };
  const label = labels[mode] ?? `${mode} mode`;
  botApi
    .sendMessage(chatId, `⚙ ${label}`, threadOpts)
    .catch((err) => debug(`tail permission_mode: ${err}`));
  break;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/watch.test.ts 2>&1 | tail -8`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/watch.ts src/__tests__/watch.test.ts
git commit -m "feat(watch): Telegram case permission_mode with dedup

Emits a single ⚙ message when mode transitions to plan, acceptEdits,
or bypassPermissions. Skips default and skips consecutive duplicates."
```

---

## Task 13: Telegram `case "hook_summary"`

**Files:**

- Modify: `src/handlers/watch.ts` — new case.
- Test: `src/__tests__/watch.test.ts`.

- [ ] **Step 1: Write failing test**

```ts
describe("watch: handleTailEvent hook_summary", () => {
  function makeMockApi() {
    const sent: Array<{ chatId: number | string; text: string }> = [];
    const api = {
      sendMessage: (chatId: number | string, text: string) => {
        sent.push({ chatId, text });
        return Promise.resolve({ message_id: 1 });
      },
      deleteMessage: () => Promise.resolve(true),
    } as unknown as Api;
    return { api, sent };
  }

  test("hook_summary with errors emits a message", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    handleTailEvent(
      api,
      state,
      {
        type: "hook_summary",
        content: "lint failed",
        hook: {
          hookCount: 1,
          errorCount: 1,
          preventedContinuation: true,
          firstError: "lint failed",
          failingHookName: "lint",
        },
      },
      6302,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("lint");
    expect(sent[0]!.text).toContain("blocked");
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `bun test src/__tests__/watch.test.ts -t "hook_summary" 2>&1 | tail -8`
Expected: fails.

- [ ] **Step 3: Add the case**

In `src/handlers/watch.ts` `handleTailEvent`:

```ts
case "hook_summary": {
  const h = event.hook;
  if (!h) break;
  const verb = h.preventedContinuation ? "blocked the run" : "failed";
  const tag = h.failingHookName
    ? ` <code>${escapeHtml(h.failingHookName)}</code>`
    : "";
  const trail = h.firstError
    ? `: ${escapeHtml(h.firstError.slice(0, 200))}`
    : "";
  botApi
    .sendMessage(
      chatId,
      `🪝 stop hook${tag} ${verb}${trail}`,
      { parse_mode: "HTML", ...threadOpts },
    )
    .catch((err) => debug(`tail hook_summary: ${err}`));
  break;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/watch.test.ts 2>&1 | tail -8`
Expected: all pass.

- [ ] **Step 5: Full backend suite + typecheck**

```bash
bunx tsc --noEmit -p .
bun run test 2>&1 | awk '/^ +[0-9]+ pass$/{p+=$1} /^ +[0-9]+ fail$/{f+=$1} END{print "pass="p" fail="f}'
```

Expected: tsc exit 0; `fail=0`.

- [ ] **Step 6: Commit**

```bash
git add src/handlers/watch.ts src/__tests__/watch.test.ts
git commit -m "feat(watch): Telegram case hook_summary

Emits a 🪝 message when a stop hook fails or prevents continuation,
including the failing hook name and first 200 chars of the error."
```

---

## Task 14: End-to-end manual verification

**Files:** none (smoke test).

- [ ] **Step 1: Restart the bot**

Run: `launchctl kickstart -k "gui/$(id -u)/com.azaidi.claude-bot"`

- [ ] **Step 2: Verify startup logs**

Run: `sleep 2 && tail -30 /tmp/claude-bot.log | head -30`
Expected: `topic-manager: reconciled N session(s)` + `auto-watch: started` lines.

- [ ] **Step 3: Trigger each new event type and observe**

In your active Claude session(s):

a. Run a `Bash` command that produces multi-line output (e.g. `ls -la /tmp`). Expected:

- **Web UI**: green bullet on the Bash tool block; result body shows last 5 lines + "+N lines" if applicable.
- **Telegram**: a `▶️ Bash: <last line> (+N lines)` message appears in the topic.

b. Run a `Grep` on something with several matches (e.g. `grep -r "function" src`). Expected:

- **Web UI**: green bullet; "Found N matches" italic line below.
- **Telegram**: `🔎 Grep: N matches` message.

c. Run an `Agent` (e.g. spawn a research subagent). Expected:

- **Web UI**: green bullet; "Done · X tools · Yk tokens · Zs" line.
- **Telegram**: `🎯 Agent done: X tools · Yk tokens · Zs` message.

d. Run a `Read` on any file. Expected:

- **Web UI**: green bullet; NO body. Suppressed on success.
- **Telegram**: NO new message (call alone tells the story).

e. Force an error (e.g. `Read` a non-existent file). Expected:

- **Web UI**: red bullet; error message body in red.
- **Telegram**: `❌ Read: ENOENT...` message.

f. Toggle plan mode (`Shift+Tab` in the desktop terminal or via slash command). Expected:

- **Web UI**: yellow banner appears at top of the chat view: "📋 Plan mode — agent will not modify files".
- **Telegram**: `⚙ Plan mode on` message.

g. Toggle plan mode OFF. Expected:

- **Web UI**: banner disappears.
- **Telegram**: NO message (default mode is the implicit norm; no banner emitted).

h. Trigger a stop hook failure if you have one configured. (Skip if no stop hook in active config.) Expected:

- **Web UI**: red inline card with hook name + error.
- **Telegram**: `🪝 stop hook X blocked the run: <error>` message.

- [ ] **Step 4: Cross-surface consistency check**

After running steps a–g, scroll back through both the web UI and the Telegram topic for the same session. Confirm:

- Every promoted tool_result that appeared in the web UI has a corresponding Telegram message (and vice versa).
- Suppressed tools (Read/Write/Edit) do NOT spam Telegram with empty result messages.
- The permission_mode banner state in the web UI matches the most-recent Telegram permission_mode message.

- [ ] **Step 5: Final commit if any tweaks were needed**

If the manual verification surfaced a label tweak or a missed edge case, commit it as a focused fix. Otherwise no commit.

---

## Spec coverage self-check

- Spec §"Data model" (TailEvent extension) → Task 1
- Spec §"Tailer changes / parseLine top-level entries" → Tasks 2 (permission_mode), 3 (hook_summary)
- Spec §"Tailer changes / parseLine tool_result" → Task 4
- Spec §"SSE event extension" + bridge → Task 5
- Spec §"Web history replay" → Task 6
- Spec §"Web UI rendering / ToolBlock + colour" → Task 8
- Spec §"Web UI rendering / per-tool result body" → Task 9
- Spec §"Web UI rendering / PermissionModeBanner" + "HookSummaryCard" → Task 10
- Spec §"Telegram rendering / case tool_result + selective promote" → Task 11
- Spec §"Telegram rendering / case permission_mode" → Task 12
- Spec §"Telegram rendering / case hook_summary" → Task 13
- Spec §"Test matrix" items 1–14 → distributed across all tasks
- Spec §"Risks / mitigations" — registry size cap is in Task 11; race tolerance is implicit in Task 8 (Map-set on receipt regardless of order); permission_mode dedup state is in Tasks 10 (web) and 12 (Telegram); promoted-message-survives-cleanup is enforced in Task 11 by NOT tracking as currentToolMsg.

No placeholders. Type names consistent: `TailEvent.toolUseId / isError / permissionMode / hook` used identically across all tasks.

Total: **14 tasks**, each commit-bounded, ~5–15 minutes per task. Recommended execution: subagent-driven, same as the unified-chat-truth feature (commits c9b0d02..d3be37a).
