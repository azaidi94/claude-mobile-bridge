# Session Event Bus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish all user messages (Telegram, web UI) to `globalEventBus` so every consumer sees every message, making Telegram and web UI stay in sync without point-to-point wiring.

**Architecture:** Extend the existing `globalEventBus` (SessionEventBus, keyed by session name) with a `user_message` event type. Add two publish points (Telegram handler, web UI message route) and one new subscriber (cross-post non-Telegram user messages to the Telegram topic). The relay TCP path stays for injection; all delivery goes through the bus.

**Tech Stack:** Bun, TypeScript, Hono (server), grammy (Telegram), React + Vitest (web frontend), existing `globalEventBus` in `src/web/sse.ts`.

---

### Task 1: Add `user_message` to SseEvent type

**Files:**

- Modify: `src/web/sse.ts` (lines 3–28, the SseEvent interface)
- Modify: `web/src/api.ts` (lines 31–56, the frontend SseEvent interface)

- [ ] **Step 1: Add `user_message` to the backend SseEvent type**

In `src/web/sse.ts`, replace the `type` union and add a `source` field:

```typescript
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
    | "hook_summary"
    | "user_message";
  content: string;
  source?: "telegram" | "web" | "terminal" | "cursor";
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

- [ ] **Step 2: Mirror the change in the frontend type**

In `web/src/api.ts`, make the same change to the `SseEvent` interface:

```typescript
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
    | "hook_summary"
    | "user_message";
  content: string;
  source?: "telegram" | "web" | "terminal" | "cursor";
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

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/web/sse.ts web/src/api.ts
git commit -m "feat(bus): add user_message event type to SseEvent"
```

---

### Task 2: Publish Telegram user messages to the bus

**Files:**

- Modify: `src/handlers/text.ts` (around line 347, after `sendWatchRelay` succeeds)

The `sendWatchRelay` call happens at line 338. When it returns `true`, the message was sent to Claude. At that point, publish it to the bus so web UI subscribers see it.

`topicCtx.sessionName` is available in scope (line 87). The bus key is session name.

- [ ] **Step 1: Add the bus import**

At the top of `src/handlers/text.ts`, add:

```typescript
import { globalEventBus } from "../web/sse";
```

- [ ] **Step 2: Emit after successful relay**

After the `if (relayed)` block at line 347, just before the `ctx.replyWithChatAction(...)` call, add:

```typescript
    if (relayed) {
      // Publish to bus so web UI and other consumers see this user message
      const busKey = topicCtx?.sessionName ?? String(chatId);
      globalEventBus.emit(busKey, {
        type: "user_message",
        source: "telegram",
        content: message,
      });
      ctx
        .replyWithChatAction("typing", { message_thread_id: threadId })
        .catch(() => {});
```

Note: `topicCtx` is in scope (defined at line 82). When in a non-topic chat `topicCtx` is null — use `String(chatId)` as fallback (no subscriber will be listening on that key, so the emit is a safe no-op).

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Run tests**

```bash
bun run test
```

Expected: all pass. No behavioral change yet — we're only adding a publish.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/text.ts
git commit -m "feat(bus): publish Telegram user messages to session event bus"
```

---

### Task 3: Publish web UI user messages to the bus

**Files:**

- Modify: `src/web/routes/sessions.ts` (the `POST /:id/message` handler, around line 188)

- [ ] **Step 1: Emit before sendWebRelay**

In the `app.post("/:id/message", ...)` handler, add the emit right after `busKey` is resolved and before the `if (found?.source === "desktop")` branch:

```typescript
  app.post("/:id/message", async (c) => {
    const sessionId = c.req.param("id");
    const body = await c.req.json<{ text: string }>();
    if (!body.text?.trim()) return c.json({ error: "text required" }, 400);

    const sessions = getSessions();
    const found = sessions.find((s) => s.id === sessionId);
    const busKey = found?.name ?? sessionId;

    const emit = (type: SseEvent["type"], content: string) =>
      globalEventBus.emit(busKey, { type, content });

    // Publish user message to bus so Telegram and other consumers see it
    globalEventBus.emit(busKey, {
      type: "user_message",
      source: "web",
      content: body.text,
    });

    if (found?.source === "desktop") {
      sendWebRelay(found, body.text, emit);
    } else {
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run tests**

```bash
bun run test
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/web/routes/sessions.ts
git commit -m "feat(bus): publish web UI user messages to session event bus"
```

---

### Task 4: Cross-post non-Telegram user messages to Telegram

**Files:**

- Modify: `src/handlers/watch.ts` (add a helper function near `setupIdDriftDetection` at line 558, and call it from `startAutoWatch` at line 750)

The helper subscribes to the bus for the session and forwards `user_message` events from non-Telegram sources to the Telegram topic. It returns an unsubscribe function stored on `WatchState` so it is cleaned up when the watch stops.

- [ ] **Step 1: Check WatchState for an unsubscribe slot**

Read `src/handlers/watch.ts` around lines 1–100 to find the `WatchState` interface (or wherever it's defined). Add an `unsubCrossPost?: () => void` field.

Find the interface definition with:

```bash
grep -n "interface WatchState\|WatchState {" src/handlers/watch.ts
```

Add the field:

```typescript
interface WatchState {
  // ... existing fields ...
  unsubCrossPost?: () => void;
}
```

- [ ] **Step 2: Write the failing test**

In `src/__tests__/watch.test.ts`, add a new test after the existing watch tests:

```typescript
describe("cross-post subscription", () => {
  test("forwards web user_message to Telegram but not telegram source", async () => {
    const { globalEventBus } = await import("../web/sse");
    const mockApi = {
      sendMessage: vi.fn().mockResolvedValue({}),
    } as unknown as Api;

    const fakeWatchState = {
      chatId: 100,
      threadId: 42,
      sessionName: "my-session",
    } as unknown as WatchState;

    setupCrossPostSubscription(mockApi, fakeWatchState, globalEventBus);

    // Web message → should forward to Telegram
    globalEventBus.emit("my-session", {
      type: "user_message",
      source: "web",
      content: "hello from web",
    });
    expect(mockApi.sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("hello from web"),
      expect.objectContaining({ message_thread_id: 42 }),
    );

    // Telegram message → should NOT forward (would cause echo)
    mockApi.sendMessage.mockClear();
    globalEventBus.emit("my-session", {
      type: "user_message",
      source: "telegram",
      content: "hello from tg",
    });
    expect(mockApi.sendMessage).not.toHaveBeenCalled();

    // Non-user_message event → should NOT forward
    mockApi.sendMessage.mockClear();
    globalEventBus.emit("my-session", { type: "text", content: "response" });
    expect(mockApi.sendMessage).not.toHaveBeenCalled();

    // Cleanup
    fakeWatchState.unsubCrossPost?.();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test src/__tests__/watch.test.ts 2>&1 | tail -10
```

Expected: FAIL — `setupCrossPostSubscription` is not exported.

- [ ] **Step 4: Implement `setupCrossPostSubscription`**

Add the function near `setupIdDriftDetection` (around line 558) in `src/handlers/watch.ts`:

```typescript
import type { Api } from "grammy";
import { globalEventBus, type SessionEventBus } from "../web/sse";

export function setupCrossPostSubscription(
  botApi: Api,
  watchState: WatchState,
  bus: SessionEventBus = globalEventBus,
): void {
  const { chatId, threadId, sessionName } = watchState;

  const unsub = bus.subscribe(sessionName, (evt) => {
    if (evt.type !== "user_message") return;
    if (evt.source === "telegram") return; // don't echo back
    const prefix =
      evt.source === "web"
        ? "🌐 Web"
        : evt.source === "cursor"
          ? "🖱 Cursor"
          : "🖥 Terminal";
    botApi
      .sendMessage(chatId, `${prefix}: ${evt.content}`, {
        message_thread_id: threadId,
      })
      .catch(() => {});
  });

  watchState.unsubCrossPost = unsub;
}
```

Also export `SessionEventBus` from `src/web/sse.ts` (add `export` to the class declaration).

- [ ] **Step 5: Call it from `startAutoWatch`**

In `startAutoWatch` (around line 750, just after `setupIdDriftDetection`):

```typescript
setupIdDriftDetection(botApi, watchState);
setupCrossPostSubscription(botApi, watchState);
```

And the same at the second call site around line 974.

- [ ] **Step 6: Clean up on watch stop**

Find where watches are stopped (search for `watches.delete` or `tailer.stop()`). When a watch is stopped, call `watchState.unsubCrossPost?.()`. Add it alongside the existing tailer and interval cleanup.

- [ ] **Step 7: Run test to verify it passes**

```bash
bun test src/__tests__/watch.test.ts 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Step 8: Run all tests**

```bash
bun run test
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/handlers/watch.ts src/web/sse.ts src/__tests__/watch.test.ts
git commit -m "feat(bus): cross-post non-Telegram user messages to Telegram topic"
```

---

### Task 5: Render `user_message` events in the web UI Terminal

**Files:**

- Modify: `web/src/components/Terminal.tsx` (the `groupIntoTurns` function at line 644 and `PANE_THEMES` at line 689)
- Test: `web/src/__tests__/Terminal.test.tsx`

The `groupIntoTurns` function currently groups events into `user | desktop | assistant` turns based on content prefixes. We add `user_message` events as a new `"remote"` role (messages from Telegram or other non-web sources appearing in the web UI).

- [ ] **Step 1: Write failing tests**

In `web/src/__tests__/Terminal.test.tsx`, add:

```typescript
test("renders user_message from telegram as a remote turn", () => {
  const events: SseEvent[] = [
    { type: "user_message", source: "telegram", content: "hi from telegram" },
  ];
  const { container } = render(<Terminal events={events} streaming={false} />);
  expect(container.textContent).toContain("hi from telegram");
  expect(container.textContent).toContain("Telegram");
});

test("renders user_message from web with web label", () => {
  const events: SseEvent[] = [
    { type: "user_message", source: "web", content: "hi from web" },
  ];
  const { container } = render(<Terminal events={events} streaming={false} />);
  expect(container.textContent).toContain("hi from web");
  expect(container.textContent).toContain("Web");
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd web && bun run test 2>&1 | tail -10
```

Expected: FAIL — `user_message` events are silently ignored.

- [ ] **Step 3: Update the Turn type and groupIntoTurns**

In `web/src/components/Terminal.tsx`:

1. Extend the `Turn` type:

```typescript
interface Turn {
  role: "user" | "desktop" | "assistant" | "remote";
  source?: "telegram" | "web" | "terminal" | "cursor";
  items: { evt: SseEvent; idx: number }[];
}
```

2. In `groupIntoTurns`, handle `user_message` before the existing `text` checks:

```typescript
if (evt.type === "user_message") {
  turns.push({ role: "remote", source: evt.source, items: [{ evt, idx }] });
  return;
}
```

- [ ] **Step 4: Add a theme for `remote` turns**

In `PANE_THEMES`, add an entry for `"remote"`:

```typescript
  remote: {
    label: "Remote",
    border: "border-sky-400/25",
    headerBg: "bg-sky-500/15",
    headerText: "text-sky-300",
    headerHover: "hover:bg-sky-500/20",
    headerBorderBottom: "border-sky-400/20",
  },
```

- [ ] **Step 5: Display the source label in the pane header**

In the component that renders the turn header (search for `turn.role === "assistant"` in Terminal.tsx around line 787), update the label to show source:

Find the section that renders `PANE_THEMES[turn.role].label` and update it:

```typescript
{
  turn.role === "remote"
    ? sourceLabel(turn.source)
    : PANE_THEMES[turn.role].label;
}
```

Add the helper above the component:

```typescript
function sourceLabel(source?: string): string {
  if (source === "telegram") return "📱 Telegram";
  if (source === "cursor") return "🖱 Cursor";
  if (source === "web") return "🌐 Web";
  return "🖥 Remote";
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd web && bun run test 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Step 7: Run all tests**

```bash
bun run test && cd web && bun run test
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add web/src/components/Terminal.tsx web/src/__tests__/Terminal.test.tsx
git commit -m "feat(bus): render remote user_message events in web UI Terminal"
```

---

## Self-Review

**Spec coverage:**

- ✅ `user_message` event type added to SseEvent (Task 1)
- ✅ Telegram publishes to bus (Task 2)
- ✅ Web UI publishes to bus (Task 3)
- ✅ Telegram subscribes and cross-posts non-Telegram messages (Task 4)
- ✅ Web UI renders `user_message` events (Task 5)
- ✅ Source filtering: Telegram subscriber ignores `source: "telegram"` (Task 4)
- ✅ Relay TCP injection path unchanged — no regression risk

**Placeholder scan:** None found.

**Type consistency:**

- `SseEvent["type"]` extended with `"user_message"` in Task 1, used identically in Tasks 2, 3, 4, 5.
- `source` field optional on `SseEvent`, defaulting to `undefined` for existing events — no breaking change.
- `Turn["role"]` extended with `"remote"` in Task 5; `PANE_THEMES` updated to include `"remote"` in the same task — no missing key.
- `setupCrossPostSubscription` exported from `src/handlers/watch.ts` and imported in the test in Task 4.
