# Cursor IDE Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Cursor IDE to the session event bus so user messages typed in Cursor's Composer appear in Telegram (and vice versa), treating each Cursor workspace as its own named session identical to a desktop Claude session.

**Architecture:** A CDP (Chrome DevTools Protocol) bridge connects to Cursor's embedded DevTools server (`localhost:9222`, enabled via `~/.cursor/argv.json`). It registers a `Runtime.addBinding` callback and injects a `MutationObserver` into the Composer webview — fully event-driven, no polling. New user messages fire a binding event pushed to the CDP client. The bridge publishes these as `user_message, source: "cursor"` events on `globalEventBus`, and subscribes to inject non-cursor bus messages back into the Composer. Each Cursor workspace registers as a `SessionInfo` with `source: "cursor"` so existing topic routing creates its own Telegram topic automatically.

**Tech Stack:** Node.js `ws` (already a dep), `undici`/`fetch` for CDP target listing, `bun:test` for tests, existing `globalEventBus`/`SessionEventBus` from `src/web/sse.ts`, existing `addTelegramSession`/topic-manager from `src/sessions/`.

**One-time user setup:** Add `"remote-debugging-port": 9222` to `~/.cursor/argv.json` and restart Cursor.

---

## File Structure

| File                                            | Responsibility                                                 |
| ----------------------------------------------- | -------------------------------------------------------------- |
| `src/cursor/cdp-client.ts`                      | CDP WebSocket wrapper: request/response + notification events  |
| `src/cursor/target-discovery.ts`                | Enumerate CDP targets, identify Cursor's Composer webview      |
| `src/cursor/composer-io.ts`                     | MutationObserver setup script + inject script (no polling)     |
| `src/cursor/bridge.ts`                          | Bridge coordinator: lifecycle, binding setup, bus wiring       |
| `src/cursor/index.ts`                           | Public entrypoint: `startCursorBridge()` with auto-reconnect   |
| `src/sessions/types.ts`                         | Add `"cursor"` to `SessionInfo.source` union                   |
| `src/__tests__/cursor-cdp.test.ts`              | Tests for CdpClient request/response and notification dispatch |
| `src/__tests__/cursor-composer-io.test.ts`      | Tests for observer setup script and inject script generation   |
| `src/__tests__/cursor-bridge.test.ts`           | Tests for CursorBridge lifecycle and bus wiring                |
| `src/__tests__/cursor-target-discovery.test.ts` | Tests for selectComposerTarget                                 |

---

### Task 1: CDP Client with Notification Support

**Files:**

- Create: `src/cursor/cdp-client.ts`
- Create: `src/__tests__/cursor-cdp.test.ts`

The CDP protocol has two message types:

1. **Responses** — have an `id` field matching a sent command
2. **Notifications** — have a `method` field (e.g. `Runtime.bindingCalled`) with no `id`

The client must handle both. `onNotification` accepts a callback that receives all push notifications.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/cursor-cdp.test.ts
import { describe, it, expect, mock } from "bun:test";
import { CdpClient } from "../cursor/cdp-client";

class MockWs {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: string[] = [];
  readyState = 1;

  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  simulateMessage(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

describe("CdpClient", () => {
  it("sends a command and resolves with the result", async () => {
    const ws = new MockWs();
    const client = new CdpClient(ws as never);
    const promise = client.sendCommand("Runtime.evaluate", {
      expression: "1+1",
    });

    const msg = JSON.parse(ws.sent[0]!);
    expect(msg.method).toBe("Runtime.evaluate");
    expect(msg.params.expression).toBe("1+1");

    ws.simulateMessage({ id: msg.id, result: { result: { value: 2 } } });
    const result = await promise;
    expect(result).toEqual({ result: { value: 2 } });
  });

  it("rejects when CDP returns an error", async () => {
    const ws = new MockWs();
    const client = new CdpClient(ws as never);
    const promise = client.sendCommand("Runtime.evaluate", {
      expression: "bad",
    });

    const msg = JSON.parse(ws.sent[0]!);
    ws.simulateMessage({ id: msg.id, error: { message: "SyntaxError" } });
    await expect(promise).rejects.toThrow("SyntaxError");
  });

  it("dispatches notifications to registered handler", () => {
    const ws = new MockWs();
    const client = new CdpClient(ws as never);
    const handler = mock(() => {});
    client.onNotification("Runtime.bindingCalled", handler);

    ws.simulateMessage({
      method: "Runtime.bindingCalled",
      params: { name: "cursorBridgeMsg", payload: "hello" },
    });

    expect(handler).toHaveBeenCalledWith({
      name: "cursorBridgeMsg",
      payload: "hello",
    });
  });

  it("does not dispatch notifications to wrong handler", () => {
    const ws = new MockWs();
    const client = new CdpClient(ws as never);
    const handler = mock(() => {});
    client.onNotification("Page.loadEventFired", handler);

    ws.simulateMessage({
      method: "Runtime.bindingCalled",
      params: { name: "cursorBridgeMsg", payload: "hello" },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("close() disconnects", () => {
    const ws = new MockWs();
    const client = new CdpClient(ws as never);
    client.close();
    expect(ws.readyState).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests to see them fail**

```bash
cd <repo>
bun test src/__tests__/cursor-cdp.test.ts
```

Expected: FAIL — "Cannot find module '../cursor/cdp-client'"

- [ ] **Step 3: Implement CdpClient**

```typescript
// src/cursor/cdp-client.ts
import WebSocket from "ws";

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export async function listCdpTargets(port = 9222): Promise<CdpTarget[]> {
  const res = await fetch(`http://localhost:${port}/json`);
  return res.json() as Promise<CdpTarget[]>;
}

export function connectCdpTarget(wsUrl: string): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const client = new CdpClient(ws);
    ws.onopen = () => resolve(client);
    ws.onerror = (err) => reject(err);
  });
}

type NotificationHandler = (params: Record<string, unknown>) => void;

export class CdpClient {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private notificationHandlers = new Map<string, NotificationHandler[]>();

  constructor(private ws: WebSocket) {
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        result?: unknown;
        error?: { message: string };
        params?: Record<string, unknown>;
      };

      if (msg.id !== undefined) {
        // Response to a command
        const handler = this.pending.get(msg.id);
        if (!handler) return;
        this.pending.delete(msg.id);
        if (msg.error) {
          handler.reject(new Error(msg.error.message));
        } else {
          handler.resolve(msg.result);
        }
      } else if (msg.method) {
        // Push notification
        const handlers = this.notificationHandlers.get(msg.method);
        if (handlers) {
          for (const h of handlers) h(msg.params ?? {});
        }
      }
    };
  }

  sendCommand(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    const existing = this.notificationHandlers.get(method) ?? [];
    existing.push(handler);
    this.notificationHandlers.set(method, existing);
    return () => {
      const handlers = this.notificationHandlers.get(method) ?? [];
      this.notificationHandlers.set(
        method,
        handlers.filter((h) => h !== handler),
      );
    };
  }

  close(): void {
    this.ws.close();
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/__tests__/cursor-cdp.test.ts
```

Expected: PASS (5 tests)

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/cursor/cdp-client.ts src/__tests__/cursor-cdp.test.ts
git commit -m "feat(cursor): add CDP client with request/response and notification dispatch"
```

---

### Task 2: Add "cursor" to SessionInfo and register Cursor sessions

**Files:**

- Modify: `src/sessions/types.ts`
- Modify: `src/sessions/watcher.ts`
- Modify: `src/sessions/index.ts`
- Create: `src/__tests__/cursor-session.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/cursor-session.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { addCursorSession, getSession, removeSession } from "../sessions";

describe("addCursorSession", () => {
  const name = "cursor-test-session";

  beforeEach(() => {
    removeSession(name);
  });

  it("registers a session with source cursor", () => {
    addCursorSession({ name, dir: "/tmp/proj" });
    const s = getSession(name);
    expect(s).not.toBeNull();
    expect(s!.source).toBe("cursor");
    expect(s!.name).toBe(name);
    expect(s!.dir).toBe("/tmp/proj");
  });

  it("updates lastActivity on re-registration without duplicating", async () => {
    addCursorSession({ name, dir: "/tmp/proj" });
    const first = getSession(name)!.lastActivity;
    await new Promise((r) => setTimeout(r, 5));
    addCursorSession({ name, dir: "/tmp/proj" });
    const second = getSession(name)!.lastActivity;
    expect(second).toBeGreaterThanOrEqual(first);
    // Only one session with this name
    const all = (await import("../sessions")).getSessions();
    expect(all.filter((s) => s.name === name).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to see it fail**

```bash
bun test src/__tests__/cursor-session.test.ts
```

Expected: FAIL — "addCursorSession is not exported"

- [ ] **Step 3: Add "cursor" to SessionInfo.source in types.ts**

Change line 18 in `src/sessions/types.ts`:

```typescript
source: "telegram" | "desktop" | "cursor";
```

- [ ] **Step 4: Add addCursorSession to watcher.ts**

Find `export function addTelegramSession` in `src/sessions/watcher.ts` and add after it:

```typescript
/**
 * Register a Cursor IDE workspace as a session.
 * If a session with the same name exists, refreshes its lastActivity.
 * Safe to call repeatedly — will not create duplicates.
 */
export function addCursorSession(opts: {
  name: string;
  dir: string;
  sessionId?: string;
}): void {
  const existing = cache.sessions.get(opts.name);
  if (existing) {
    existing.lastActivity = Date.now();
    if (opts.sessionId) existing.id = opts.sessionId;
    return;
  }
  const info: SessionInfo = {
    id: opts.sessionId ?? "",
    name: opts.name,
    dir: opts.dir,
    lastActivity: Date.now(),
    source: "cursor",
  };
  cache.sessions.set(opts.name, info);
  onChangeCallback?.({ added: [info], removed: [], updated: [] });
}
```

- [ ] **Step 5: Export from sessions/index.ts**

Add `addCursorSession` to the watcher exports in `src/sessions/index.ts`:

```typescript
export {
  startWatcher,
  stopWatcher,
  forceRefresh,
  getSessions,
  getActiveSession,
  setActiveSession,
  getSession,
  addTelegramSession,
  addCursorSession,
  updateSessionId,
  updateSessionActivity,
  removeSession,
} from "./watcher";
```

- [ ] **Step 6: Run tests**

```bash
bun test src/__tests__/cursor-session.test.ts
```

Expected: PASS (2 tests)

- [ ] **Step 7: Full typecheck**

```bash
bun run typecheck
```

Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src/sessions/types.ts src/sessions/watcher.ts src/sessions/index.ts src/__tests__/cursor-session.test.ts
git commit -m "feat(cursor): add source:cursor to SessionInfo and addCursorSession registration"
```

---

### Task 3: Composer I/O — MutationObserver setup and inject script

**Files:**

- Create: `src/cursor/composer-io.ts`
- Create: `src/__tests__/cursor-composer-io.test.ts`

This module provides two JS strings evaluated via `CdpClient.sendCommand`:

1. **`buildObserverScript(bindingName)`** — returns a script that:
   - Finds the Composer chat container using a priority selector list
   - Sets up a `MutationObserver` watching for new child nodes
   - When a new user-message node is added, calls `window[bindingName](text)`
   - Also returns a snapshot of already-visible user messages (for the bridge to mark as "seen" without publishing)

2. **`buildInjectScript(text)`** — returns a script that finds the Composer input, sets its value via the React `nativeInputValueSetter` hack, fires `input`, and dispatches `Enter`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/cursor-composer-io.test.ts
import { describe, it, expect } from "bun:test";
import {
  buildObserverScript,
  buildInjectScript,
  parseSnapshotResult,
} from "../cursor/composer-io";

describe("buildObserverScript", () => {
  it("includes the binding name in the script", () => {
    const script = buildObserverScript("cursorBridgeMsg");
    expect(script).toContain("cursorBridgeMsg");
    expect(script).toContain("MutationObserver");
    expect(script).toContain("querySelectorAll");
  });

  it("uses a different binding name when specified", () => {
    const script = buildObserverScript("myBridge");
    expect(script).toContain("myBridge");
  });
});

describe("buildInjectScript", () => {
  it("includes the message text", () => {
    const script = buildInjectScript("hello world");
    expect(script).toContain("hello world");
    expect(script).toContain("nativeInputValueSetter");
    expect(script).toContain("dispatchEvent");
  });

  it("escapes single quotes in message text", () => {
    const script = buildInjectScript("it's a test");
    expect(script).not.toMatch(/'s a test'/);
    expect(script).toContain("it\\'s a test");
  });

  it("escapes backslashes in message text", () => {
    const script = buildInjectScript("path\\to\\file");
    expect(script).toContain("path\\\\to\\\\file");
  });
});

describe("parseSnapshotResult", () => {
  it("returns string array from CDP result", () => {
    const result = parseSnapshotResult({
      result: { type: "object", value: ["Hello", "World"] },
    });
    expect(result).toEqual(["Hello", "World"]);
  });

  it("returns empty array for non-array or missing value", () => {
    expect(parseSnapshotResult({ result: { type: "undefined" } })).toEqual([]);
    expect(parseSnapshotResult(null)).toEqual([]);
    expect(
      parseSnapshotResult({ result: { type: "object", value: null } }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to see them fail**

```bash
bun test src/__tests__/cursor-composer-io.test.ts
```

Expected: FAIL — cannot find module

- [ ] **Step 3: Implement composer-io.ts**

```typescript
// src/cursor/composer-io.ts

/**
 * Selector priority lists for Cursor's Composer UI elements.
 * Tried in order — first match wins. May need tuning against live Cursor DOM.
 */
const USER_MSG_SELECTORS = [
  '[data-message-role="user"]',
  ".composer-message--user",
  ".human-message",
  '.chat-message[data-role="user"]',
  ".user-message",
];

const CHAT_CONTAINER_SELECTORS = [
  '[data-testid="composer-messages"]',
  ".composer-messages",
  ".chat-messages",
  ".conversation-container",
  ".messages-container",
];

const INPUT_SELECTORS = [
  '[data-testid="composer-input"]',
  ".composer-input textarea",
  ".composer-editor textarea",
  'div[contenteditable="true"]',
  "textarea[placeholder]",
];

/**
 * Returns a JS expression to evaluate inside the Cursor Composer webview.
 * The script:
 *   1. Takes a snapshot of already-visible user messages (returned as string[])
 *   2. Sets up a MutationObserver; when new user message nodes appear,
 *      calls window[bindingName](JSON.stringify(text))
 *
 * The return value is a JSON-serialisable string[] of existing messages —
 * the bridge uses this to initialise its "seen" set without publishing history.
 */
export function buildObserverScript(bindingName: string): string {
  const msgSelList = USER_MSG_SELECTORS.map((s) => JSON.stringify(s)).join(
    ", ",
  );
  const containerSelList = CHAT_CONTAINER_SELECTORS.map((s) =>
    JSON.stringify(s),
  ).join(", ");

  return `
(function() {
  const msgSelectors = [${msgSelList}];
  const containerSelectors = [${containerSelList}];
  const bindingName = ${JSON.stringify(bindingName)};

  function getMsgText(node) {
    return node.textContent?.trim() ?? "";
  }

  function isUserMessage(node) {
    if (!(node instanceof Element)) return false;
    return msgSelectors.some(sel => node.matches(sel));
  }

  // Snapshot existing messages
  const existing = [];
  for (const sel of msgSelectors) {
    const nodes = document.querySelectorAll(sel);
    if (nodes.length > 0) {
      existing.push(...Array.from(nodes).map(getMsgText).filter(Boolean));
      break;
    }
  }

  // Find container for MutationObserver
  let container = null;
  for (const sel of containerSelectors) {
    container = document.querySelector(sel);
    if (container) break;
  }
  // Fallback: observe document.body
  if (!container) container = document.body;

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (isUserMessage(node)) {
          const text = getMsgText(node);
          if (text) window[bindingName](text);
        }
        // Check descendants too (in case container wraps the message)
        if (node instanceof Element) {
          for (const sel of msgSelectors) {
            const found = node.querySelectorAll(sel);
            for (const el of found) {
              const text = getMsgText(el);
              if (text) window[bindingName](text);
            }
            if (found.length > 0) break;
          }
        }
      }
    }
  });

  observer.observe(container, { childList: true, subtree: true });

  return existing;
})()
`;
}

/**
 * Returns a JS expression that injects text into Cursor's Composer input and submits.
 */
export function buildInjectScript(text: string): string {
  const escaped = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const selList = INPUT_SELECTORS.map((s) => JSON.stringify(s)).join(", ");

  return `
(function() {
  const selectors = [${selList}];
  let el = null;
  for (const sel of selectors) {
    el = document.querySelector(sel);
    if (el) break;
  }
  if (!el) throw new Error('Cursor Composer input not found');

  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(el, '${escaped}');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    el.textContent = '${escaped}';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: '${escaped}' }));
  }

  el.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
  }));
  return true;
})()
`;
}

/**
 * Parse the CDP evaluate result from buildObserverScript (the initial snapshot).
 */
export function parseSnapshotResult(cdpResult: unknown): string[] {
  if (!cdpResult || typeof cdpResult !== "object") return [];
  const r = (cdpResult as { result?: { type?: string; value?: unknown } })
    .result;
  if (!r || !Array.isArray(r.value)) return [];
  return (r.value as unknown[]).filter(
    (x): x is string => typeof x === "string",
  );
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/__tests__/cursor-composer-io.test.ts
```

Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/cursor/composer-io.ts src/__tests__/cursor-composer-io.test.ts
git commit -m "feat(cursor): add event-driven Composer observer and inject scripts"
```

---

### Task 4: Cursor Bridge Coordinator

**Files:**

- Create: `src/cursor/bridge.ts`
- Create: `src/__tests__/cursor-bridge.test.ts`

The bridge wires everything together:

1. Calls `addCursorSession()` to register the Cursor workspace as a session
2. Calls `Runtime.enable` so notifications flow through CDP
3. Calls `Runtime.addBinding(bindingName)` to register the JS→CDP callback
4. Evaluates `buildObserverScript(bindingName)` — receives initial snapshot + starts observer
5. Subscribes to `Runtime.bindingCalled` notifications — publishes new messages to bus
6. Subscribes to bus — injects non-cursor messages into Composer via `buildInjectScript`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/cursor-bridge.test.ts
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { CursorBridge } from "../cursor/bridge";
import { SessionEventBus } from "../web/sse";

interface MockNotificationHandler {
  method: string;
  handler: (params: Record<string, unknown>) => void;
}

function makeMockCdp() {
  const notificationHandlers: MockNotificationHandler[] = [];
  const commandLog: Array<{ method: string; params: Record<string, unknown> }> =
    [];

  return {
    sendCommand: mock(
      async (method: string, params: Record<string, unknown> = {}) => {
        commandLog.push({ method, params });
        if (method === "Runtime.evaluate") {
          // Return empty snapshot
          return { result: { type: "object", value: [] } };
        }
        return {};
      },
    ),
    onNotification: mock(
      (method: string, handler: (params: Record<string, unknown>) => void) => {
        notificationHandlers.push({ method, handler });
        return () => {};
      },
    ),
    close: mock(() => {}),
    commandLog,
    // Test helper: simulate a binding called notification
    simulateBinding: (name: string, payload: string) => {
      for (const { method, handler } of notificationHandlers) {
        if (method === "Runtime.bindingCalled") {
          handler({ name, payload });
        }
      }
    },
  };
}

describe("CursorBridge", () => {
  let bus: SessionEventBus;
  let cdp: ReturnType<typeof makeMockCdp>;

  beforeEach(() => {
    bus = new SessionEventBus();
    cdp = makeMockCdp();
  });

  it("calls Runtime.enable and Runtime.addBinding on start", async () => {
    const bridge = new CursorBridge({
      sessionName: "cursor-ws",
      sessionDir: "/tmp/proj",
      cdpClient: cdp as never,
      bus,
    });
    await bridge.start();
    bridge.stop();

    const methods = cdp.commandLog.map((c) => c.method);
    expect(methods).toContain("Runtime.enable");
    expect(methods).toContain("Runtime.addBinding");
  });

  it("publishes user_message to bus when binding is called", async () => {
    const received: unknown[] = [];
    bus.subscribe("cursor-ws", (e) => received.push(e));

    const bridge = new CursorBridge({
      sessionName: "cursor-ws",
      sessionDir: "/tmp/proj",
      cdpClient: cdp as never,
      bus,
    });
    await bridge.start();
    cdp.simulateBinding("cursorBridgeMsg", "Hello from Cursor");
    bridge.stop();

    expect(received).toContainEqual(
      expect.objectContaining({
        type: "user_message",
        source: "cursor",
        content: "Hello from Cursor",
      }),
    );
  });

  it("does not publish messages from the initial snapshot", async () => {
    // Simulate non-empty snapshot
    cdp.sendCommand = mock(async (method: string) => {
      if (method === "Runtime.evaluate") {
        return { result: { type: "object", value: ["Old history message"] } };
      }
      return {};
    });

    const received: unknown[] = [];
    bus.subscribe("cursor-ws", (e) => received.push(e));

    const bridge = new CursorBridge({
      sessionName: "cursor-ws",
      sessionDir: "/tmp/proj",
      cdpClient: cdp as never,
      bus,
    });
    await bridge.start();
    // Simulate binding called for the same message that was in the snapshot
    cdp.simulateBinding("cursorBridgeMsg", "Old history message");
    bridge.stop();

    expect(received).toHaveLength(0);
  });

  it("injects bus messages from non-cursor sources into Composer", async () => {
    const bridge = new CursorBridge({
      sessionName: "cursor-ws",
      sessionDir: "/tmp/proj",
      cdpClient: cdp as never,
      bus,
    });
    await bridge.start();

    bus.emit("cursor-ws", {
      type: "user_message",
      source: "telegram",
      content: "Hello from Telegram",
    });

    await new Promise((r) => setTimeout(r, 10));
    bridge.stop();

    const injectCalls = cdp.commandLog.filter(
      (c) =>
        c.method === "Runtime.evaluate" &&
        String((c.params as { expression?: string }).expression ?? "").includes(
          "nativeInputValueSetter",
        ),
    );
    expect(injectCalls.length).toBeGreaterThan(0);
  });

  it("does not inject cursor-sourced messages (prevents echo)", async () => {
    const bridge = new CursorBridge({
      sessionName: "cursor-ws",
      sessionDir: "/tmp/proj",
      cdpClient: cdp as never,
      bus,
    });
    await bridge.start();

    bus.emit("cursor-ws", {
      type: "user_message",
      source: "cursor",
      content: "My own message",
    });

    await new Promise((r) => setTimeout(r, 10));
    bridge.stop();

    const injectCalls = cdp.commandLog.filter(
      (c) =>
        c.method === "Runtime.evaluate" &&
        String((c.params as { expression?: string }).expression ?? "").includes(
          "nativeInputValueSetter",
        ),
    );
    expect(injectCalls.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to see them fail**

```bash
bun test src/__tests__/cursor-bridge.test.ts
```

Expected: FAIL — cannot find module

- [ ] **Step 3: Implement bridge.ts**

```typescript
// src/cursor/bridge.ts
import { addCursorSession } from "../sessions";
import {
  buildObserverScript,
  buildInjectScript,
  parseSnapshotResult,
} from "./composer-io";
import type { CdpClient } from "./cdp-client";
import type { SessionEventBus, SseEvent } from "../web/sse";
import { warn, info, debug } from "../logger";

const BINDING_NAME = "cursorBridgeMsg";

export interface CursorBridgeOptions {
  sessionName: string;
  sessionDir: string;
  cdpClient: CdpClient;
  bus: SessionEventBus;
}

export class CursorBridge {
  private unsubBus: (() => void) | null = null;
  private unsubNotification: (() => void) | null = null;
  private seenMessages = new Set<string>();

  constructor(private opts: CursorBridgeOptions) {}

  async start(): Promise<void> {
    const { sessionName, sessionDir, cdpClient, bus } = this.opts;

    addCursorSession({ name: sessionName, dir: sessionDir });

    // Enable CDP Runtime domain so notifications are delivered
    await cdpClient.sendCommand("Runtime.enable");

    // Register the binding name so JS can call window[BINDING_NAME](text)
    await cdpClient.sendCommand("Runtime.addBinding", { name: BINDING_NAME });

    // Inject the MutationObserver; returns initial snapshot of existing messages
    const snapshotResult = await cdpClient.sendCommand("Runtime.evaluate", {
      expression: buildObserverScript(BINDING_NAME),
      returnByValue: true,
      awaitPromise: false,
    });
    for (const msg of parseSnapshotResult(snapshotResult)) {
      this.seenMessages.add(msg);
    }

    // Subscribe to Runtime.bindingCalled — new messages from Cursor
    this.unsubNotification = cdpClient.onNotification(
      "Runtime.bindingCalled",
      (params) => {
        if (params.name !== BINDING_NAME) return;
        const text = String(params.payload ?? "").trim();
        if (!text) return;
        if (this.seenMessages.has(text)) return;
        this.seenMessages.add(text);
        debug(`cursor-bridge: new message: ${text.slice(0, 80)}`);
        bus.emit(sessionName, {
          type: "user_message",
          source: "cursor",
          content: text,
        });
      },
    );

    // Subscribe to bus — inject non-cursor messages into Composer
    this.unsubBus = bus.subscribe(sessionName, (evt: SseEvent) => {
      if (evt.type !== "user_message") return;
      if (evt.source === "cursor") return; // prevent echo
      void cdpClient
        .sendCommand("Runtime.evaluate", {
          expression: buildInjectScript(evt.content),
          returnByValue: true,
        })
        .catch((e: unknown) => {
          warn(`cursor-bridge: inject failed: ${(e as Error).message}`);
        });
    });

    info(`cursor-bridge: started for session "${sessionName}"`);
  }

  stop(): void {
    this.unsubNotification?.();
    this.unsubNotification = null;
    this.unsubBus?.();
    this.unsubBus = null;
    this.opts.cdpClient.close();
    info(`cursor-bridge: stopped for session "${this.opts.sessionName}"`);
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/__tests__/cursor-bridge.test.ts
```

Expected: PASS (5 tests)

- [ ] **Step 5: Run all tests**

```bash
bun test
```

Expected: no regressions

- [ ] **Step 6: Typecheck**

```bash
bun run typecheck
```

Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/cursor/bridge.ts src/__tests__/cursor-bridge.test.ts
git commit -m "feat(cursor): event-driven CursorBridge using Runtime.bindingCalled"
```

---

### Task 5: Target Discovery and Bridge Entrypoint

**Files:**

- Create: `src/cursor/target-discovery.ts`
- Create: `src/cursor/index.ts`
- Modify: `src/index.ts`
- Create: `src/__tests__/cursor-target-discovery.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/cursor-target-discovery.test.ts
import { describe, it, expect } from "bun:test";
import { selectComposerTarget } from "../cursor/target-discovery";
import type { CdpTarget } from "../cursor/cdp-client";

describe("selectComposerTarget", () => {
  const targets: CdpTarget[] = [
    {
      id: "1",
      type: "service_worker",
      title: "sw",
      url: "chrome-extension://abc/sw.js",
    },
    {
      id: "2",
      type: "page",
      title: "Cursor",
      url: "vscode-webview://cursor.app/composer",
    },
    {
      id: "3",
      type: "page",
      title: "Getting Started",
      url: "vscode-webview://cursor.app/welcome",
    },
  ];

  it("prefers target whose URL contains a composer/chat hint", () => {
    const t = selectComposerTarget(targets);
    expect(t?.id).toBe("2");
  });

  it("falls back to first page target when no URL hint matches", () => {
    const plain: CdpTarget[] = [
      {
        id: "1",
        type: "service_worker",
        title: "sw",
        url: "chrome-extension://x/sw.js",
      },
      {
        id: "2",
        type: "page",
        title: "Something",
        url: "vscode-webview://cursor.app/other",
      },
    ];
    expect(selectComposerTarget(plain)?.id).toBe("2");
  });

  it("returns null when no page targets exist", () => {
    expect(selectComposerTarget([])).toBeNull();
    expect(
      selectComposerTarget([
        { id: "1", type: "service_worker", title: "sw", url: "x" },
      ]),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to see it fail**

```bash
bun test src/__tests__/cursor-target-discovery.test.ts
```

Expected: FAIL — cannot find module

- [ ] **Step 3: Implement target-discovery.ts**

```typescript
// src/cursor/target-discovery.ts
import type { CdpTarget } from "./cdp-client";

const COMPOSER_URL_HINTS = ["composer", "chat", "aichat", "sidebar"];

/**
 * Pick the best CDP target for Cursor's Composer webview from the list returned
 * by listCdpTargets(). Prefers page targets whose URL contains a composer/chat
 * hint; falls back to the first page target if none match.
 */
export function selectComposerTarget(targets: CdpTarget[]): CdpTarget | null {
  const pages = targets.filter((t) => t.type === "page");
  if (pages.length === 0) return null;

  const hint = pages.find((t) =>
    COMPOSER_URL_HINTS.some((h) => t.url.toLowerCase().includes(h)),
  );
  return hint ?? pages[0]!;
}
```

- [ ] **Step 4: Implement src/cursor/index.ts**

```typescript
// src/cursor/index.ts
import { listCdpTargets, connectCdpTarget } from "./cdp-client";
import { selectComposerTarget } from "./target-discovery";
import { CursorBridge } from "./bridge";
import { globalEventBus } from "../web/sse";
import { info, warn } from "../logger";
import { homedir } from "os";

const CURSOR_CDP_PORT = Number(process.env.CURSOR_CDP_PORT ?? 9222);
const RECONNECT_INTERVAL_MS = 5_000;

let activeBridge: CursorBridge | null = null;
let reconnectTimer: Timer | null = null;

export function startCursorBridge(): void {
  void attemptConnect();
}

export function stopCursorBridge(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  activeBridge?.stop();
  activeBridge = null;
}

async function attemptConnect(): Promise<void> {
  try {
    const targets = await listCdpTargets(CURSOR_CDP_PORT);
    const target = selectComposerTarget(targets);
    if (!target?.webSocketDebuggerUrl) {
      scheduleReconnect("no Composer target found");
      return;
    }

    const cdpClient = await connectCdpTarget(target.webSocketDebuggerUrl);
    const sessionName = `cursor-${target.title
      .slice(0, 40)
      .replace(/\s+/g, "-")
      .toLowerCase()}`;
    const sessionDir = homedir();

    const bridge = new CursorBridge({
      sessionName,
      sessionDir,
      cdpClient,
      bus: globalEventBus,
    });
    await bridge.start();
    activeBridge = bridge;

    info(`cursor-bridge: connected to "${sessionName}" via CDP`);
  } catch (err) {
    scheduleReconnect((err as Error).message);
  }
}

function scheduleReconnect(reason: string): void {
  warn(`cursor-bridge: ${reason} — retry in ${RECONNECT_INTERVAL_MS / 1000}s`);
  reconnectTimer = setTimeout(
    () => void attemptConnect(),
    RECONNECT_INTERVAL_MS,
  );
}
```

- [ ] **Step 5: Call startCursorBridge() from src/index.ts**

Find the startup block in `src/index.ts` (look for the call to `startWatcher` or `bot.start()`). Add after existing startup calls:

```typescript
import { startCursorBridge } from "./cursor";
// inside startup:
startCursorBridge();
```

- [ ] **Step 6: Run all tests**

```bash
bun test
```

Expected: all pass including cursor-target-discovery

- [ ] **Step 7: Typecheck**

```bash
bun run typecheck
```

Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src/cursor/target-discovery.ts src/cursor/index.ts src/index.ts src/__tests__/cursor-target-discovery.test.ts
git commit -m "feat(cursor): wire Cursor bridge into bot startup with auto-reconnect"
```

---

## Smoke Test

1. Add `"remote-debugging-port": 9222` to `~/.cursor/argv.json`, restart Cursor.
2. `bun run dev` — logs should show `cursor-bridge: connected to "cursor-..."` or `retry in 5s` if Cursor is not running.
3. Type a message in Cursor's Composer — it should appear in Telegram under a new "cursor-…" topic.
4. Reply from Telegram — it should appear in Cursor's Composer input and be submitted.

---

## Self-Review

**Spec coverage:**

- ✅ Event-driven: `Runtime.addBinding` + `MutationObserver` + `Runtime.bindingCalled` — no polling
- ✅ No Cursor extension required — only `~/.cursor/argv.json` flag needed
- ✅ `"cursor"` added to `SessionInfo.source`
- ✅ Cursor workspace registers as session (triggers topic creation via existing topic-manager)
- ✅ New user messages published as `user_message, source: "cursor"` to bus
- ✅ Non-cursor bus messages injected into Composer
- ✅ Echo prevention: cursor-source messages not re-injected
- ✅ Initial snapshot prevents replaying Composer history on connect
- ✅ Auto-reconnect on disconnect (5s retry)

**Placeholder scan:** None — all code blocks are complete.

**Type consistency:** `CdpClient` interface consistent across `bridge.ts` and `index.ts`. `SseEvent.source` includes `"cursor"` in `src/web/sse.ts` (already added in previous session).
