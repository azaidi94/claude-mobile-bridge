# AskUserQuestion Remote Bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a PreToolUse hook + bot HTTP bridge so Claude Code's built-in `AskUserQuestion` becomes answerable from Telegram or the Web UI in parallel with the local TUI, with first-answer-wins resolution.

**Architecture:** Bash entry hook returns `permissionDecision: "allow"` immediately (local TUI opens) and spawns a detached Bun/TS worker. Worker POSTs the question to a new `/api/auq-bridge` endpoint, long-polls for the answer. Bot reuses the existing `postQuestionToTelegram` helper for TG inline keyboards and emits `ask_remote` SSE events for Web UI. Local-TUI wins are detected via the bot's existing JSONL tailer (`tool_result` events on `globalEventBus`).

**Tech Stack:** Bun + TypeScript, Hono, grammy, the existing `globalEventBus`, bash, tmux send-keys.

**Spec:** `docs/superpowers/specs/2026-05-11-auq-remote-bridge-design.md`

---

## File Structure

**New files:**

| Path                                           | Responsibility                                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/handlers/auq-bridge-registry.ts`          | In-memory Map of pending bridges. Pure data: register, get, resolve, delete, observe cancellation signal. No I/O.                                       |
| `src/handlers/auq-bridge.ts`                   | Orchestrator. Receives a bridge request, loops questions, calls TG/SSE emit, awaits answers, handles cancellation. Pure logic — collaborators injected. |
| `src/web/routes/auq-bridge.ts`                 | Hono route. Auth check, cwd → watch resolution, registry register, long-poll GET.                                                                       |
| `~/.claude/hooks/claude-remote-auq-bridge.sh`  | Bash PreToolUse entry. Reads stdin, validates, spawns worker, outputs allow JSON. <100ms.                                                               |
| `~/.claude/hooks/claude-remote-auq-worker.ts`  | TS/Bun background worker. POST → long-poll → tmux send-keys injection.                                                                                  |
| `src/__tests__/auq-bridge-registry.test.ts`    | Unit tests for registry.                                                                                                                                |
| `src/__tests__/auq-bridge-handler.test.ts`     | Unit tests for orchestrator (single-Q, multi-Q, cancellation, custom-text).                                                                             |
| `src/__tests__/web-auq-bridge-route.test.ts`   | HTTP route tests.                                                                                                                                       |
| `src/__tests__/auq-bridge-worker-keys.test.ts` | Worker keystroke-generation tests (no real tmux).                                                                                                       |
| `src/__tests__/auq-bridge-hook.test.ts`        | Bash hook subprocess tests.                                                                                                                             |

**Modified files:**

| Path                         | Change                                                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config.ts`              | Add `RELAY_AUQ_SECRET` env var parsing.                                                                                                              |
| `.env.example`               | Document `RELAY_AUQ_SECRET`.                                                                                                                         |
| `src/handlers/relay-ask.ts`  | (a) Export `postQuestionToTelegram` as a shared helper; (b) extend callback-data dispatcher to route `bridge:*` callbacks to the new bridge handler. |
| `src/web/routes/sessions.ts` | Extend `POST /ask-remote-answer` to also accept `bridge:*` askIds (route to bridge handler).                                                         |
| `src/web/server.ts`          | Mount `app.route("/api/auq-bridge", createAuqBridgeRouter())`.                                                                                       |
| `~/.claude/settings.json`    | Add `PreToolUse` hook entry (the **go-live** step).                                                                                                  |
| `README.md`                  | New feature bullet under §Features.                                                                                                                  |

---

## Task 1 — Add `RELAY_AUQ_SECRET` to config

**Files:**

- Modify: `src/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add the env var to config.ts**

Find the block where other shared-secret-style env vars are exported (search for `WEB_PORT` near line 299). Add immediately after `WEB_URL`:

```typescript
/**
 * Shared secret the AUQ-bridge hook + worker include as Bearer auth when
 * calling /api/auq-bridge. Localhost-only by design, but the secret stops
 * any other local process from hijacking pending AUQs. Empty = bridge
 * disabled (hook will refuse to spawn workers).
 */
export const RELAY_AUQ_SECRET = process.env.RELAY_AUQ_SECRET?.trim() || "";
```

- [ ] **Step 2: Add to .env.example**

Append before the final section:

```bash
# AUQ remote-bridge shared secret (set to enable the AskUserQuestion bridge —
# hook script and worker include this as Authorization: Bearer <secret>).
# Empty/unset disables the bridge; built-in AskUserQuestion falls back to
# local TUI only.
RELAY_AUQ_SECRET=
```

- [ ] **Step 3: Commit**

```bash
git add src/config.ts .env.example
git commit -m "feat(config): RELAY_AUQ_SECRET env var for AUQ-bridge auth"
```

---

## Task 2 — Bridge registry types + Map

**Files:**

- Create: `src/handlers/auq-bridge-registry.ts`
- Create: `src/__tests__/auq-bridge-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/auq-bridge-registry.test.ts
import "./ensure-test-env";
import { describe, test, expect, beforeEach } from "bun:test";

describe("AuqBridgeRegistry", () => {
  beforeEach(async () => {
    const { _resetForTests } = await import("../handlers/auq-bridge-registry");
    _resetForTests();
  });

  test("register returns the same bridge state on get", async () => {
    const { register, get } = await import("../handlers/auq-bridge-registry");
    const b = register({
      requestId: "auq_1",
      toolUseId: "toolu_x",
      sessionName: "s",
      chatId: 100,
      threadId: 42,
      questions: [
        { question: "Q1", options: [{ label: "A" }, { label: "B" }] },
      ],
    });
    expect(get("auq_1")).toBe(b);
    expect(b.answers).toEqual([]);
  });

  test("resolve marks the bridge answered + invokes waiter", async () => {
    const { register, resolve, waitFor } =
      await import("../handlers/auq-bridge-registry");
    register({
      requestId: "auq_2",
      toolUseId: "toolu_y",
      sessionName: "s",
      chatId: 100,
      threadId: 42,
      questions: [
        { question: "Q1", options: [{ label: "A" }, { label: "B" }] },
      ],
    });
    const p = waitFor("auq_2", 1000);
    resolve("auq_2", {
      status: "answered",
      answers: [{ question: "Q1", answer: "A" }],
    });
    const result = await p;
    expect(result).toEqual({
      status: "answered",
      answers: [{ question: "Q1", answer: "A" }],
    });
  });

  test("waitFor resolves to cancelled when resolve is called with cancelled", async () => {
    const { register, resolve, waitFor } =
      await import("../handlers/auq-bridge-registry");
    register({
      requestId: "auq_3",
      toolUseId: "toolu_z",
      sessionName: "s",
      chatId: 100,
      threadId: 42,
      questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }],
    });
    const p = waitFor("auq_3", 1000);
    resolve("auq_3", { status: "cancelled", reason: "answered_locally" });
    expect(await p).toEqual({
      status: "cancelled",
      reason: "answered_locally",
    });
  });

  test("waitFor times out", async () => {
    const { register, waitFor } =
      await import("../handlers/auq-bridge-registry");
    register({
      requestId: "auq_4",
      toolUseId: "toolu_w",
      sessionName: "s",
      chatId: 100,
      threadId: 42,
      questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(await waitFor("auq_4", 50)).toEqual({ status: "timeout" });
  });

  test("delete removes the entry", async () => {
    const { register, get, deleteEntry } =
      await import("../handlers/auq-bridge-registry");
    register({
      requestId: "auq_5",
      toolUseId: "t",
      sessionName: "s",
      chatId: 1,
      threadId: 2,
      questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(get("auq_5")).toBeDefined();
    deleteEntry("auq_5");
    expect(get("auq_5")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/auq-bridge-registry.test.ts -v`
Expected: FAIL with `Cannot find module '../handlers/auq-bridge-registry'`

- [ ] **Step 3: Create the registry**

```typescript
// src/handlers/auq-bridge-registry.ts
/**
 * In-memory registry of pending AUQ bridges. Pure data + waiter signalling;
 * no I/O. The orchestrator (`auq-bridge.ts`) and the HTTP route
 * (`web/routes/auq-bridge.ts`) both use this as their shared state.
 */

export interface AuqQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface AuqAnswer {
  question: string;
  answer: string;
}

export interface BridgeInit {
  requestId: string;
  toolUseId: string;
  sessionName: string;
  chatId: number;
  threadId: number;
  questions: AuqQuestion[];
  tmuxPane?: string;
}

export type BridgeResolution =
  | { status: "answered"; answers: AuqAnswer[] }
  | { status: "cancelled"; reason: string }
  | { status: "timeout" };

interface BridgeState extends BridgeInit {
  answers: AuqAnswer[];
  /** index of the question currently awaiting an answer (0-based). */
  currentIndex: number;
  /** Resolution if already set, else null. */
  resolution: BridgeResolution | null;
  /** Waiters subscribed via waitFor(). */
  waiters: Array<(r: BridgeResolution) => void>;
  /** Per-question per-surface TG card message ids, for editing on cancel. */
  tgMessageIds: Map<number, number>;
}

const bridges = new Map<string, BridgeState>();

export function register(init: BridgeInit): BridgeState {
  const state: BridgeState = {
    ...init,
    answers: [],
    currentIndex: 0,
    resolution: null,
    waiters: [],
    tgMessageIds: new Map(),
  };
  bridges.set(init.requestId, state);
  return state;
}

export function get(requestId: string): BridgeState | undefined {
  return bridges.get(requestId);
}

/** Resolve the bridge; idempotent — only the first call sticks. */
export function resolve(requestId: string, r: BridgeResolution): void {
  const b = bridges.get(requestId);
  if (!b || b.resolution) return;
  b.resolution = r;
  for (const w of b.waiters) w(r);
  b.waiters = [];
}

/**
 * Wait for the bridge's resolution. If already resolved, returns immediately.
 * Otherwise resolves on the next call to `resolve()` or after `timeoutMs`.
 */
export function waitFor(
  requestId: string,
  timeoutMs: number,
): Promise<BridgeResolution> {
  return new Promise((res) => {
    const b = bridges.get(requestId);
    if (!b) {
      res({ status: "cancelled", reason: "no such bridge" });
      return;
    }
    if (b.resolution) {
      res(b.resolution);
      return;
    }
    const timer = setTimeout(() => {
      const idx = b.waiters.indexOf(handler);
      if (idx >= 0) b.waiters.splice(idx, 1);
      res({ status: "timeout" });
    }, timeoutMs);
    const handler = (r: BridgeResolution) => {
      clearTimeout(timer);
      res(r);
    };
    b.waiters.push(handler);
  });
}

export function deleteEntry(requestId: string): void {
  bridges.delete(requestId);
}

export function _resetForTests(): void {
  bridges.clear();
}

export function _allForTests(): ReadonlyMap<string, BridgeState> {
  return bridges;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/auq-bridge-registry.test.ts -v`
Expected: PASS, 5 tests, 0 fail.

- [ ] **Step 5: Run typecheck + full canonical**

Run: `bun run typecheck && bun run test 2>&1 | tail -5`
Expected: typecheck clean; canonical pass count ≥ baseline (no existing tests touched).

- [ ] **Step 6: Commit**

```bash
git add src/handlers/auq-bridge-registry.ts src/__tests__/auq-bridge-registry.test.ts
git commit -m "feat(auq-bridge): pending-bridge registry + waiter API"
```

---

## Task 3 — Extract `postQuestionToTelegram` as a shared helper

**Files:**

- Modify: `src/handlers/relay-ask.ts`

The existing function is private (line 121 of `relay-ask.ts`). The new bridge needs to call it. No behavior change — just export.

- [ ] **Step 1: Change `async function` to `export async function`**

In `src/handlers/relay-ask.ts`, line 121:

Before:

```typescript
async function postQuestionToTelegram(
```

After:

```typescript
export async function postQuestionToTelegram(
```

- [ ] **Step 2: Look at the function signature — does it depend on `client.sessionName`?**

It does (line 163: `const sessionName = client.sessionName;`). The bridge uses a `sessionName` directly (not a `RelayClient`). To preserve API compatibility with the existing MCP-ask_remote caller while making it bridge-friendly, leave the signature unchanged for this task — the bridge will adapt by constructing a minimal pseudo-client. (Real refactor of the signature is out of scope; YAGNI.)

- [ ] **Step 3: Run full canonical to confirm nothing broke**

Run: `bun run test 2>&1 | grep -E "(pass|fail)" | tail -5`
Expected: same count as baseline.

- [ ] **Step 4: Commit**

```bash
git add src/handlers/relay-ask.ts
git commit -m "refactor(relay-ask): export postQuestionToTelegram for AUQ-bridge reuse"
```

---

## Task 4 — AuqBridge orchestrator skeleton + single-question test

**Files:**

- Create: `src/handlers/auq-bridge.ts`
- Create: `src/__tests__/auq-bridge-handler.test.ts`

- [ ] **Step 1: Write the failing test (single-question happy path with mocks)**

```typescript
// src/__tests__/auq-bridge-handler.test.ts
import "./ensure-test-env";
import { describe, test, expect, beforeEach, mock } from "bun:test";

describe("auq-bridge orchestrator: single-question", () => {
  beforeEach(async () => {
    const { _resetForTests } = await import("../handlers/auq-bridge-registry");
    _resetForTests();
  });

  test("posts one TG card, emits SSE, resolves on TG answer", async () => {
    const { register } = await import("../handlers/auq-bridge-registry");
    const { runBridge, _injectTgAnswer } =
      await import("../handlers/auq-bridge");

    const tgCalls: Array<{
      chatId: number;
      threadId: number;
      question: string;
    }> = [];
    const sseCalls: Array<{ sessionName: string; askId: string }> = [];

    const state = register({
      requestId: "auq_1",
      toolUseId: "toolu_x",
      sessionName: "s",
      chatId: 100,
      threadId: 42,
      questions: [
        { question: "Pick", options: [{ label: "A" }, { label: "B" }] },
      ],
    });

    const promise = runBridge(state, {
      postTg: async (args) => {
        tgCalls.push(args);
        return { messageId: 999 };
      },
      emitSse: (ev) => sseCalls.push({ sessionName: "s", askId: ev.askId! }),
      clearedSse: () => {},
    });

    // Simulate TG button tap arriving via the dispatcher
    _injectTgAnswer("auq_1", 0, "A");

    const r = await promise;
    expect(r.status).toBe("answered");
    if (r.status === "answered") {
      expect(r.answers).toEqual([{ question: "Pick", answer: "A" }]);
    }
    expect(tgCalls).toHaveLength(1);
    expect(tgCalls[0]!.question).toBe("Pick");
    expect(sseCalls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/auq-bridge-handler.test.ts -v`
Expected: FAIL with `Cannot find module '../handlers/auq-bridge'`.

- [ ] **Step 3: Create the orchestrator (single-question first)**

```typescript
// src/handlers/auq-bridge.ts
/**
 * AUQ-bridge orchestrator. Given a registered bridge, post a TG inline-keyboard
 * card and a Web UI `ask_remote` SSE event for each question (sequentially),
 * await an answer on any surface, return all answers when complete. Cancels
 * cleanly when the bot's JSONL tailer signals a local-TUI answer for the
 * matching `tool_use_id`.
 *
 * Collaborators (TG send, SSE emit, JSONL bus subscription) are injected so
 * the orchestrator stays pure and unit-testable.
 */

import { resolve as resolveBridge, get } from "./auq-bridge-registry";
import type { BridgeResolution } from "./auq-bridge-registry";
import type { SseEvent } from "../web/sse";

export interface PostTgArgs {
  chatId: number;
  threadId: number;
  askId: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  allowCustom: boolean;
}

export interface BridgeOrchestratorDeps {
  postTg: (args: PostTgArgs) => Promise<{ messageId: number }>;
  emitSse: (ev: SseEvent) => void;
  /** Called when the bridge resolves so each surface can be cleaned up. */
  clearedSse: (askId: string, resolution: "answered" | "cancelled") => void;
}

/**
 * Map of (requestId → per-question waiters) so external callers (TG callback
 * dispatcher, Web UI POST /ask-remote-answer) can deliver an answer to the
 * orchestrator without going through the bus.
 */
const questionWaiters = new Map<
  string,
  Map<number, (answer: string) => void>
>();

function askIdFor(requestId: string, questionIndex: number): string {
  return `bridge:${requestId}:${questionIndex}`;
}

/**
 * Parse `bridge:<request_id>:<question_index>` from a callback / Web UI askId.
 * Returns null if the format doesn't match.
 */
export function parseBridgeAskId(
  askId: string,
): { requestId: string; questionIndex: number } | null {
  if (!askId.startsWith("bridge:")) return null;
  const parts = askId.split(":");
  if (parts.length !== 3) return null;
  const qi = parseInt(parts[2]!, 10);
  if (!Number.isFinite(qi)) return null;
  return { requestId: parts[1]!, questionIndex: qi };
}

/** Called by the TG callback dispatcher when a bridge:* button is tapped. */
export function _injectTgAnswer(
  requestId: string,
  questionIndex: number,
  answer: string,
): boolean {
  const perReq = questionWaiters.get(requestId);
  const waiter = perReq?.get(questionIndex);
  if (!waiter) return false;
  waiter(answer);
  return true;
}

/** Same path for Web UI answers. */
export function _injectWebAnswer(
  requestId: string,
  questionIndex: number,
  answer: string,
): boolean {
  return _injectTgAnswer(requestId, questionIndex, answer);
}

export async function runBridge(
  state: {
    requestId: string;
    chatId: number;
    threadId: number;
    questions: any[];
  },
  deps: BridgeOrchestratorDeps,
): Promise<BridgeResolution> {
  const perReq = new Map<number, (answer: string) => void>();
  questionWaiters.set(state.requestId, perReq);
  try {
    const answers: Array<{ question: string; answer: string }> = [];
    for (let i = 0; i < state.questions.length; i++) {
      const q = state.questions[i];
      const askId = askIdFor(state.requestId, i);
      const allowCustom = q.multiSelect !== true;

      const sent = await deps.postTg({
        chatId: state.chatId,
        threadId: state.threadId,
        askId,
        question: q.question,
        options: q.options,
        allowCustom,
      });
      const bridge = get(state.requestId);
      if (bridge) bridge.tgMessageIds.set(i, sent.messageId);

      deps.emitSse({
        type: "ask_remote",
        content: q.question,
        askId,
        askQuestion: q.question,
        askOptions: q.options.map((o: any) => ({
          label: o.label,
          description: o.description,
        })),
        askAllowCustom: allowCustom,
      });

      // Await answer for this question (or bridge-level cancellation)
      const answer = await new Promise<string | null>((res) => {
        perReq.set(i, (a) => res(a));
        // If bridge is cancelled while we wait, resolution promise wins
        const b = get(state.requestId);
        if (b?.resolution) res(null);
      });
      if (answer === null) {
        return (
          get(state.requestId)?.resolution ?? {
            status: "cancelled",
            reason: "unknown",
          }
        );
      }
      answers.push({ question: q.question, answer });
      deps.clearedSse(askId, "answered");
    }
    const resolution: BridgeResolution = { status: "answered", answers };
    resolveBridge(state.requestId, resolution);
    return resolution;
  } finally {
    questionWaiters.delete(state.requestId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/auq-bridge-handler.test.ts -v`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/auq-bridge.ts src/__tests__/auq-bridge-handler.test.ts
git commit -m "feat(auq-bridge): orchestrator skeleton + single-question test"
```

---

## Task 5 — Multi-question flow

**Files:**

- Modify: `src/__tests__/auq-bridge-handler.test.ts`

- [ ] **Step 1: Add the multi-question test**

Append to the `describe` block:

```typescript
test("loops 3 questions sequentially, returns answers in order", async () => {
  const { register } = await import("../handlers/auq-bridge-registry");
  const { runBridge, _injectTgAnswer } = await import("../handlers/auq-bridge");

  const tgCalls: string[] = [];
  const state = register({
    requestId: "auq_m",
    toolUseId: "toolu_m",
    sessionName: "s",
    chatId: 100,
    threadId: 42,
    questions: [
      { question: "Q1", options: [{ label: "A" }, { label: "B" }] },
      { question: "Q2", options: [{ label: "X" }, { label: "Y" }] },
      { question: "Q3", options: [{ label: "P" }, { label: "Q" }] },
    ],
  });

  const promise = runBridge(state, {
    postTg: async (args) => {
      tgCalls.push(args.question);
      // Answer the question we just posted, in order, on the next tick.
      const qi = tgCalls.length - 1;
      const answer = ["A", "Y", "Q"][qi]!;
      setTimeout(() => _injectTgAnswer("auq_m", qi, answer), 0);
      return { messageId: 1000 + qi };
    },
    emitSse: () => {},
    clearedSse: () => {},
  });

  const r = await promise;
  expect(r.status).toBe("answered");
  if (r.status === "answered") {
    expect(r.answers).toEqual([
      { question: "Q1", answer: "A" },
      { question: "Q2", answer: "Y" },
      { question: "Q3", answer: "Q" },
    ]);
  }
  expect(tgCalls).toEqual(["Q1", "Q2", "Q3"]);
});
```

- [ ] **Step 2: Run test to verify**

Run: `bun test src/__tests__/auq-bridge-handler.test.ts -v`
Expected: PASS, 2 tests. (The orchestrator from Task 4 already handles multi-Q via the for-loop.)

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/auq-bridge-handler.test.ts
git commit -m "test(auq-bridge): lock multi-question sequential flow"
```

---

## Task 6 — Cancellation on bus `tool_result`

**Files:**

- Modify: `src/handlers/auq-bridge.ts`
- Modify: `src/__tests__/auq-bridge-handler.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe` block:

```typescript
test("cancels bridge when tool_result for matching tool_use_id arrives on bus", async () => {
  const { register } = await import("../handlers/auq-bridge-registry");
  const { runBridge, attachBusCancellation } =
    await import("../handlers/auq-bridge");
  const { SessionEventBus } = await import("../web/sse");
  const bus = new SessionEventBus();
  const clearedCalls: Array<{ askId: string; resolution: string }> = [];

  const state = register({
    requestId: "auq_c",
    toolUseId: "toolu_cancel",
    sessionName: "s-cancel",
    chatId: 100,
    threadId: 42,
    questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }],
  });

  attachBusCancellation(state, bus);

  const promise = runBridge(state, {
    postTg: async () => ({ messageId: 999 }),
    emitSse: () => {},
    clearedSse: (askId, resolution) => clearedCalls.push({ askId, resolution }),
  });

  // Simulate the JSONL tailer emitting tool_result for our tool_use_id.
  bus.emit("s-cancel", {
    type: "tool_result",
    content: "ok",
    toolUseId: "toolu_cancel",
  });

  const r = await promise;
  expect(r.status).toBe("cancelled");
  if (r.status === "cancelled") expect(r.reason).toBe("answered_locally");
  expect(clearedCalls.some((c) => c.resolution === "cancelled")).toBe(true);
});
```

- [ ] **Step 2: Run test — should fail**

Run: `bun test src/__tests__/auq-bridge-handler.test.ts -v -t cancels`
Expected: FAIL — `attachBusCancellation` not exported, plus the orchestrator doesn't yet wake the per-question waiter on cancellation.

- [ ] **Step 3: Implement bus cancellation hookup**

Append to `src/handlers/auq-bridge.ts`:

```typescript
import { SessionEventBus, globalEventBus } from "../web/sse";

/**
 * Subscribe to the bus for the bridge's session. When a `tool_result` event
 * arrives with the matching `tool_use_id`, mark the bridge cancelled and wake
 * the currently-pending per-question waiter so `runBridge` returns immediately.
 */
export function attachBusCancellation(
  state: {
    requestId: string;
    toolUseId: string;
    sessionName: string;
  },
  bus: SessionEventBus = globalEventBus,
): () => void {
  const unsub = bus.subscribe(state.sessionName, (evt) => {
    if (evt.type !== "tool_result") return;
    if (evt.toolUseId !== state.toolUseId) return;
    const cancelled = {
      status: "cancelled" as const,
      reason: "answered_locally",
    };
    resolveBridge(state.requestId, cancelled);
    // Wake any in-flight per-question waiter so runBridge's await unblocks
    const perReq = questionWaiters.get(state.requestId);
    if (perReq) for (const [, w] of perReq) w("");
  });
  return unsub;
}
```

Also, update the per-question await loop in `runBridge` so that when a waiter is awoken with empty string AFTER cancellation has been recorded, we return the cancellation resolution. Replace the `if (answer === null)` block with:

```typescript
if (answer === null || get(state.requestId)?.resolution) {
  const final = get(state.requestId)?.resolution ?? {
    status: "cancelled" as const,
    reason: "unknown",
  };
  // Emit cleared for the surface card so it doesn't sit stale.
  deps.clearedSse(
    askId,
    final.status === "answered" ? "answered" : "cancelled",
  );
  return final;
}
```

- [ ] **Step 4: Run test**

Run: `bun test src/__tests__/auq-bridge-handler.test.ts -v -t cancels`
Expected: PASS, 1 test.

- [ ] **Step 5: Run all tests in the file**

Run: `bun test src/__tests__/auq-bridge-handler.test.ts -v`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/handlers/auq-bridge.ts src/__tests__/auq-bridge-handler.test.ts
git commit -m "feat(auq-bridge): cancel on bus tool_result for matching tool_use_id"
```

---

## Task 7 — Wire `bridge:*` callback routing in `relay-ask.ts`

**Files:**

- Modify: `src/handlers/relay-ask.ts`

Reuse the existing TG inline-keyboard callback handler. Add a branch that recognizes `bridge:<requestId>:<questionIndex>:<optionIndex>` (or `:custom` suffix) callbacks and routes them to `_injectTgAnswer`.

- [ ] **Step 1: Find the callback handler**

Run: `grep -n "callback_query\|callbackQuery\|on(\"callback_query\")\|on('callback_query'" src/handlers/relay-ask.ts | head -3`
Expect: location of the existing handler. (If not in relay-ask.ts, search `src/` for `callback_query`.)

- [ ] **Step 2: Add the `bridge:*` branch**

In the callback handler, after the existing `ask:*` pattern matching, add:

```typescript
// AUQ-bridge callback: `bridge:<requestId>:<questionIndex>:<optionIndex>`
// or `bridge:<requestId>:<questionIndex>:custom`
if (data.startsWith("bridge:")) {
  const parts = data.split(":");
  if (parts.length !== 4) {
    await ctx
      .answerCallbackQuery({ text: "invalid bridge callback" })
      .catch(() => {});
    return;
  }
  const requestId = parts[1]!;
  const questionIndex = parseInt(parts[2]!, 10);
  const tag = parts[3]!;

  const { get } = await import("./auq-bridge-registry");
  const bridge = get(requestId);
  if (!bridge) {
    await ctx.answerCallbackQuery({ text: "expired" }).catch(() => {});
    return;
  }
  const q = bridge.questions[questionIndex];
  if (!q) {
    await ctx.answerCallbackQuery({ text: "invalid question" }).catch(() => {});
    return;
  }
  let answer: string | null = null;
  if (tag === "custom") {
    // Custom-text path: capture next text message in chat as the answer.
    // Reuse existing customTextPending machinery.
    setCustomTextPending(bridge.chatId, bridge.threadId, async (text) => {
      const { _injectTgAnswer } = await import("./auq-bridge");
      _injectTgAnswer(requestId, questionIndex, text);
    });
    await ctx
      .answerCallbackQuery({ text: "Type your answer in chat" })
      .catch(() => {});
    return;
  }
  const optionIndex = parseInt(tag, 10);
  if (Number.isFinite(optionIndex) && q.options[optionIndex]) {
    answer = q.options[optionIndex].label;
  }
  if (answer === null) {
    await ctx.answerCallbackQuery({ text: "invalid option" }).catch(() => {});
    return;
  }
  const { _injectTgAnswer } = await import("./auq-bridge");
  if (_injectTgAnswer(requestId, questionIndex, answer)) {
    await ctx.answerCallbackQuery({ text: `✓ ${answer}` }).catch(() => {});
  } else {
    await ctx.answerCallbackQuery({ text: "already answered" }).catch(() => {});
  }
  return;
}
```

(Adapt `setCustomTextPending` to whatever the existing helper is — search `customTextPending` in `relay-ask.ts` for the existing API.)

- [ ] **Step 3: Run full canonical**

Run: `bun run typecheck && bun run test 2>&1 | tail -5`
Expected: typecheck clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/handlers/relay-ask.ts
git commit -m "feat(relay-ask): route bridge:* TG callbacks to AUQ-bridge handler"
```

---

## Task 8 — Wire `bridge:*` Web UI askId routing

**Files:**

- Modify: `src/web/routes/sessions.ts`

- [ ] **Step 1: Extend `POST /ask-remote-answer`**

Replace the existing handler (lines 267–289) with a version that checks for `bridge:*` askIds and routes them to the bridge:

```typescript
app.post("/ask-remote-answer", async (c) => {
  const body = await c.req.json<{
    ask_id?: string;
    answer?: string;
    cancel?: boolean;
  }>();
  const askId = String(body.ask_id ?? "");
  if (!askId) return c.json({ error: "ask_id required" }, 400);

  // Bridge route
  if (askId.startsWith("bridge:")) {
    const { parseBridgeAskId, _injectWebAnswer } =
      await import("../../handlers/auq-bridge");
    const parsed = parseBridgeAskId(askId);
    if (!parsed) return c.json({ error: "invalid bridge askId" }, 400);
    if (body.cancel) {
      // Cancel = treat as resolution failure on this question; for simplicity
      // in M1 we don't cancel mid-flight from Web UI (TG can't either).
      return c.json({ error: "cancel not supported for bridge" }, 400);
    }
    const answer = String(body.answer ?? "");
    if (!answer.trim()) return c.json({ error: "answer required" }, 400);
    const ok = _injectWebAnswer(parsed.requestId, parsed.questionIndex, answer);
    return ok
      ? c.json({ ok: true })
      : c.json({ error: "bridge not pending" }, 404);
  }

  // Existing MCP-ask_remote path (unchanged)
  if (body.cancel) {
    const ok = cancelAnswerFromWeb(askId);
    return ok
      ? c.json({ ok: true })
      : c.json({ error: "ask not pending" }, 404);
  }
  const answer = String(body.answer ?? "");
  if (!answer.trim()) {
    return c.json({ error: "answer required (or pass cancel:true)" }, 400);
  }
  const ok = submitAnswerFromWeb(askId, answer);
  return ok ? c.json({ ok: true }) : c.json({ error: "ask not pending" }, 404);
});
```

- [ ] **Step 2: Run full canonical**

Run: `bun run typecheck && bun run test 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/web/routes/sessions.ts
git commit -m "feat(web): route bridge:* askIds in /ask-remote-answer"
```

---

## Task 9 — HTTP route `/api/auq-bridge` (POST + GET long-poll)

**Files:**

- Create: `src/web/routes/auq-bridge.ts`
- Create: `src/__tests__/web-auq-bridge-route.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/web-auq-bridge-route.test.ts
import "./ensure-test-env";
import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";

const SECRET = "test-secret-123";

async function buildApp() {
  process.env.RELAY_AUQ_SECRET = SECRET;
  process.env.WEB_AUTH_BYPASS = "true";
  const { createAuqBridgeRouter } = await import("../web/routes/auq-bridge");
  const app = new Hono();
  app.route("/api/auq-bridge", createAuqBridgeRouter());
  return app;
}

describe("POST /api/auq-bridge", () => {
  beforeEach(async () => {
    const { _resetForTests } = await import("../handlers/auq-bridge-registry");
    _resetForTests();
    const { _resetWatchesForTests, _registerWatchForTests } =
      await import("../handlers/watch");
    _resetWatchesForTests();
    _registerWatchForTests({
      chatId: 100,
      threadId: 42,
      sessionName: "s1",
      sessionId: "id1",
      sessionDir: "/repo/saas",
      currentToolMsg: null,
      currentTextMsg: null,
      currentTextContent: "",
      lastTextUpdate: 0,
      segmentDone: true,
      lastEventTime: Date.now(),
      tailer: { stop: () => {} },
    } as any);
  });

  test("401 on missing auth", async () => {
    const app = await buildApp();
    const res = await app.request("/api/auq-bridge", {
      method: "POST",
      body: JSON.stringify({
        request_id: "x",
        cwd: "/repo/saas",
        questions: [],
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  test("401 on wrong auth", async () => {
    const app = await buildApp();
    const res = await app.request("/api/auq-bridge", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer nope",
      },
      body: JSON.stringify({
        request_id: "x",
        cwd: "/repo/saas",
        questions: [],
      }),
    });
    expect(res.status).toBe(401);
  });

  test("404 when no watch matches cwd", async () => {
    const app = await buildApp();
    const res = await app.request("/api/auq-bridge", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({
        request_id: "auq_1",
        tool_use_id: "toolu_x",
        session_id: "sid",
        cwd: "/unknown/dir",
        questions: [
          { question: "Q", options: [{ label: "A" }, { label: "B" }] },
        ],
      }),
    });
    expect(res.status).toBe(404);
  });

  test("200 + request_id when watch matches", async () => {
    const app = await buildApp();
    const res = await app.request("/api/auq-bridge", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({
        request_id: "auq_2",
        tool_use_id: "toolu_y",
        session_id: "sid",
        cwd: "/repo/saas",
        questions: [
          { question: "Q", options: [{ label: "A" }, { label: "B" }] },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { request_id: string; chatId: number };
    expect(body.request_id).toBe("auq_2");
    expect(body.chatId).toBe(100);
  });
});

describe("GET /api/auq-bridge/:id/answer", () => {
  beforeEach(async () => {
    const { _resetForTests } = await import("../handlers/auq-bridge-registry");
    _resetForTests();
  });

  test("returns answer when bridge is resolved", async () => {
    const app = await buildApp();
    const { register, resolve } =
      await import("../handlers/auq-bridge-registry");
    register({
      requestId: "auq_x",
      toolUseId: "t",
      sessionName: "s",
      chatId: 1,
      threadId: 2,
      questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }],
    });
    setTimeout(
      () =>
        resolve("auq_x", {
          status: "answered",
          answers: [{ question: "Q", answer: "A" }],
        }),
      10,
    );

    const res = await app.request("/api/auq-bridge/auq_x/answer", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("answered");
    expect(body.answers[0].answer).toBe("A");
  });

  test("returns 408 when long-poll window elapses", async () => {
    const app = await buildApp();
    const { register } = await import("../handlers/auq-bridge-registry");
    register({
      requestId: "auq_t",
      toolUseId: "t",
      sessionName: "s",
      chatId: 1,
      threadId: 2,
      questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }],
    });
    // Short-poll window via header so the test doesn't wait 30s
    const res = await app.request("/api/auq-bridge/auq_t/answer?wait_ms=50", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(408);
  });
});
```

- [ ] **Step 2: Run tests — should fail (module not found)**

Run: `bun test src/__tests__/web-auq-bridge-route.test.ts -v`
Expected: FAIL.

- [ ] **Step 3: Add `findWatchByDir` to watch.ts first**

The route needs a way to look up a watch by its `sessionDir`. `src/handlers/watch.ts` keeps `watches` private; add an exported lookup. Find the line near `_getWatchForTests` and add:

```typescript
/** Return the first active watch whose sessionDir matches `cwd`, or null. */
export function findWatchByDir(cwd: string): WatchState | null {
  for (const [, w] of watches) {
    if (w.sessionDir === cwd) return w;
  }
  return null;
}
```

- [ ] **Step 4: Create the route**

```typescript
// src/web/routes/auq-bridge.ts
import { Hono } from "hono";
import { RELAY_AUQ_SECRET } from "../../config";
import {
  register,
  waitFor,
  deleteEntry,
} from "../../handlers/auq-bridge-registry";
import { findWatchByDir } from "../../handlers/watch";

interface PostBody {
  request_id: string;
  tool_use_id: string;
  session_id: string;
  cwd: string;
  questions: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
  tmux_pane?: string;
}

function checkAuth(c: {
  req: { header: (k: string) => string | undefined };
}): boolean {
  if (!RELAY_AUQ_SECRET) return false;
  const h = c.req.header("Authorization") ?? "";
  return h === `Bearer ${RELAY_AUQ_SECRET}`;
}

export function createAuqBridgeRouter(): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    if (!checkAuth(c)) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json<PostBody>();
    if (!body?.request_id || !body?.cwd || !body?.questions?.length) {
      return c.json({ error: "missing fields" }, 400);
    }
    const watch = findWatchByDir(body.cwd);
    if (!watch) return c.json({ error: "no active watch for cwd" }, 404);

    register({
      requestId: body.request_id,
      toolUseId: body.tool_use_id,
      sessionName: watch.sessionName,
      chatId: watch.chatId,
      threadId: watch.threadId,
      questions: body.questions,
      tmuxPane: body.tmux_pane,
    });
    // Kick off orchestrator + bus cancellation in the background. The async
    // wiring lives in a separate setup helper added in Task 10.
    const { startBridgeFromRoute } = await import("../../handlers/auq-bridge");
    startBridgeFromRoute(body.request_id).catch(() => {});

    return c.json({
      request_id: body.request_id,
      chatId: watch.chatId,
      threadId: watch.threadId,
    });
  });

  app.get("/:id/answer", async (c) => {
    if (!checkAuth(c)) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    const waitMs = Math.min(
      parseInt(c.req.query("wait_ms") ?? "30000", 10) || 30000,
      60_000,
    );
    const result = await waitFor(id, waitMs);
    if (result.status === "timeout") return c.json({ status: "timeout" }, 408);
    // Clean up after delivering the final answer.
    deleteEntry(id);
    return c.json(result);
  });

  return app;
}
```

- [ ] **Step 5: Add `startBridgeFromRoute` to auq-bridge.ts**

Append:

```typescript
import { Api } from "grammy";
import { get as getBridge } from "./auq-bridge-registry";
import { postQuestionToTelegram } from "./relay-ask";

let botApi: Api | null = null;
export function setBotApiForBridge(api: Api): void {
  botApi = api;
}

/**
 * Called by the HTTP route to kick off the orchestrator + bus cancellation
 * for a freshly-registered bridge. Resolves when the bridge resolves.
 */
export async function startBridgeFromRoute(requestId: string): Promise<void> {
  const state = getBridge(requestId);
  if (!state) return;
  if (botApi) attachBusCancellation(state);

  await runBridge(state, {
    postTg: async (args) => {
      if (!botApi) return { messageId: 0 };
      // Build a minimal RelayClient-shape for postQuestionToTelegram.
      const fakeClient: any = { sessionName: state.sessionName };
      const cb = `bridge:${args.askId.replace(/^bridge:/, "")}`;
      // postQuestionToTelegram's existing implementation is keyed by
      // `req.ask_id` — pass our bridge:* ask_id through so the keyboard
      // callbacks match the dispatcher we wired in Task 7.
      await postQuestionToTelegram(botApi, fakeClient, {
        ask_id: args.askId,
        chat_id: String(args.chatId),
        thread_id: String(args.threadId),
        question: args.question,
        options: args.options,
        allow_custom: args.allowCustom,
      } as any);
      // postQuestionToTelegram stores the messageId in its own pendingAsks
      // map; we don't need it here since the orchestrator stores its own
      // mapping. Return 0 as a placeholder.
      return { messageId: 0 };
    },
    emitSse: (ev) => globalEventBus.emit(state.sessionName, ev),
    clearedSse: (askId, resolution) => {
      globalEventBus.emit(state.sessionName, {
        type: "ask_remote_cleared",
        content: "",
        askId,
        askResolution: resolution === "answered" ? "answered" : "cancelled",
      });
    },
  });
}
```

- [ ] **Step 6: Run tests**

Run: `bun test src/__tests__/web-auq-bridge-route.test.ts -v`
Expected: PASS, 5 tests.

- [ ] **Step 7: Run full canonical**

Run: `bun run typecheck && bun run test 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/web/routes/auq-bridge.ts src/handlers/watch.ts src/handlers/auq-bridge.ts src/__tests__/web-auq-bridge-route.test.ts
git commit -m "feat(web): /api/auq-bridge POST + GET long-poll endpoints"
```

---

## Task 10 — Mount route + wire bot API at startup

**Files:**

- Modify: `src/web/server.ts`
- Modify: `src/bot.ts` (or wherever the bot starts and has access to `api`)

- [ ] **Step 1: Mount the route**

In `src/web/server.ts`, after the existing `app.route("/api/sessions", ...)` line:

```typescript
import { createAuqBridgeRouter } from "./routes/auq-bridge";
// ...
app.route("/api/auq-bridge", createAuqBridgeRouter());
```

- [ ] **Step 2: Pass bot API to the bridge module at startup**

Find where the bot's `Api` instance is created (search `new Bot(`, then `bot.api`). After the bot is initialized, add:

```typescript
import { setBotApiForBridge } from "./handlers/auq-bridge";
// ...
setBotApiForBridge(bot.api);
```

- [ ] **Step 3: Run typecheck + tests**

Run: `bun run typecheck && bun run test 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/web/server.ts src/bot.ts
git commit -m "wire(auq-bridge): mount route + inject bot api at startup"
```

---

## Task 11 — Bash entry hook script

**Files:**

- Create: `~/.claude/hooks/claude-remote-auq-bridge.sh`
- Create: `src/__tests__/auq-bridge-hook.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/auq-bridge-hook.test.ts
import "./ensure-test-env";
import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";
import { existsSync } from "fs";

const HOOK = join(
  process.env.HOME!,
  ".claude/hooks/claude-remote-auq-bridge.sh",
);

describe("AUQ-bridge hook script", () => {
  test("exists and is executable", () => {
    expect(existsSync(HOOK)).toBe(true);
  });

  test("returns allow JSON for non-AskUserQuestion tools (no-op fast path)", () => {
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "t1",
      session_id: "s1",
      cwd: "/tmp",
    });
    const r = spawnSync(HOOK, [], { input, timeout: 1000 });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.toString());
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput).toBeUndefined();
  });

  test("returns allow JSON for AskUserQuestion when bot unreachable", () => {
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: "Q", options: [{ label: "A" }, { label: "B" }] },
        ],
      },
      tool_use_id: "t2",
      session_id: "s2",
      cwd: "/tmp",
    });
    // RELAY_AUQ_SECRET intentionally empty → hook should detect "disabled" and
    // pass through without spawning a worker.
    const r = spawnSync(HOOK, [], {
      input,
      timeout: 1000,
      env: { ...process.env, RELAY_AUQ_SECRET: "" },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.toString());
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("completes in <500ms", () => {
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {},
      tool_use_id: "t3",
      session_id: "s3",
      cwd: "/tmp",
    });
    const start = Date.now();
    spawnSync(HOOK, [], { input, timeout: 500 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});
```

- [ ] **Step 2: Run — should fail (script doesn't exist)**

Run: `bun test src/__tests__/auq-bridge-hook.test.ts -v`
Expected: FAIL.

- [ ] **Step 3: Create the hook script**

Save to `~/.claude/hooks/claude-remote-auq-bridge.sh`:

```bash
#!/bin/bash
# Claude Code PreToolUse hook — AskUserQuestion remote bridge.
# Reads tool-call JSON on stdin. For AskUserQuestion calls, spawns a detached
# worker that bridges the question to the mobile-bridge bot. For any other
# tool, exits with a passthrough "allow" verdict. Designed to finish in
# <100ms so CC's tool dispatch isn't blocked.

set -euo pipefail

# 1. Read the entire stdin payload from CC.
INPUT="$(cat)"

# 2. Always emit the passthrough verdict — local TUI handles AUQ normally.
emit_allow() {
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}
JSON
}

# 3. Cheap field extraction. Fall back to grep+cut so we don't need jq.
TOOL=$(printf '%s' "$INPUT" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)

# 4. Only bridge AskUserQuestion. Anything else is a no-op passthrough.
if [ "$TOOL" != "AskUserQuestion" ]; then
  emit_allow
  exit 0
fi

# 5. Bridge disabled (no secret) → passthrough.
if [ -z "${RELAY_AUQ_SECRET:-}" ]; then
  emit_allow
  exit 0
fi

# 6. Bot reachable on configured port? Probe with a 100ms HEAD-ish ping.
WEB_PORT="${WEB_PORT:-3000}"
if ! curl -s -o /dev/null -m 0.1 "http://localhost:${WEB_PORT}/api/auq-bridge/_ping" \
     -H "Authorization: Bearer ${RELAY_AUQ_SECRET}"; then
  : # ignore — health endpoint may not exist; we'll let the worker decide
fi

# 7. Spawn the detached worker. nohup + disown so it survives this script.
LOG_DIR="${HOME}/.claude/logs"
mkdir -p "$LOG_DIR"
WORKER="${HOME}/.claude/hooks/claude-remote-auq-worker.ts"
TMUX_PANE="${TMUX_PANE:-}"

# Pass the original CC JSON + extra fields (request_id, tmux_pane) into the
# worker via stdin. Use a here-doc that's already-substituted to avoid
# subshell quoting hell.
REQUEST_ID="auq_$(uuidgen 2>/dev/null || python3 -c 'import uuid;print(uuid.uuid4().hex)')"
WORKER_INPUT=$(printf '%s' "$INPUT" | python3 -c '
import json, sys, os
d = json.load(sys.stdin)
d["request_id"] = os.environ["REQUEST_ID"]
d["tmux_pane"] = os.environ.get("TMUX_PANE", "")
print(json.dumps(d))
' REQUEST_ID="$REQUEST_ID" TMUX_PANE="$TMUX_PANE")

# Detach the worker so this script can exit immediately.
(
  nohup bun run "$WORKER" <<<"$WORKER_INPUT" \
    >>"$LOG_DIR/auq-bridge-worker.log" 2>&1 &
) &
disown 2>/dev/null || true

# 8. Always emit allow.
emit_allow
exit 0
```

- [ ] **Step 4: Make executable**

```bash
chmod +x ~/.claude/hooks/claude-remote-auq-bridge.sh
```

- [ ] **Step 5: Run test**

Run: `bun test src/__tests__/auq-bridge-hook.test.ts -v`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

Note: the hook script lives under `~/.claude/hooks/`, OUTSIDE the repo. Commit only the test:

```bash
git add src/__tests__/auq-bridge-hook.test.ts
git commit -m "test(auq-bridge): hook entry script schema + perf test"
```

Save the script alongside the existing user-level hooks; record the install step in the README task (Task 14).

---

## Task 12 — TS worker script + keystroke tests

**Files:**

- Create: `~/.claude/hooks/claude-remote-auq-worker.ts`
- Create: `src/__tests__/auq-bridge-worker-keys.test.ts`

- [ ] **Step 1: Write the keystroke-generation test**

The worker imports `generateTmuxKeys` (a pure function). Test that.

```typescript
// src/__tests__/auq-bridge-worker-keys.test.ts
import "./ensure-test-env";
import { describe, test, expect } from "bun:test";

// We test the keystroke logic by extracting the pure function into the
// worker module. The actual `tmux send-keys` invocation is tested by manual
// smoke.
async function load() {
  return import(
    `${process.env.HOME}/.claude/hooks/claude-remote-auq-worker.ts`
  );
}

describe("worker: generateTmuxKeys", () => {
  test("labelled option → digit + Enter", async () => {
    const { generateTmuxKeys } = await load();
    const keys = generateTmuxKeys({
      pane: "%12",
      question: { options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
      answer: "B",
    });
    expect(keys).toEqual([
      ["send-keys", "-t", "%12", "Escape"],
      ["send-keys", "-t", "%12", "2", "Enter"],
    ]);
  });

  test("custom text → 'Type something' option + text + Enter", async () => {
    const { generateTmuxKeys } = await load();
    const keys = generateTmuxKeys({
      pane: "%12",
      question: { options: [{ label: "A" }, { label: "B" }] },
      answer: "some custom thing",
    });
    // 'Type something.' is option N+1 in CC's TUI; for 2-option AUQ that's "3".
    expect(keys).toEqual([
      ["send-keys", "-t", "%12", "Escape"],
      ["send-keys", "-t", "%12", "3", "Enter"],
      ["send-keys", "-t", "%12", "some custom thing", "Enter"],
    ]);
  });

  test("custom text with special chars passes through (tmux send-keys handles its own escaping)", async () => {
    const { generateTmuxKeys } = await load();
    const keys = generateTmuxKeys({
      pane: "%12",
      question: { options: [{ label: "A" }, { label: "B" }] },
      answer: "weird ' \" ; `chars`",
    });
    expect(keys[2]).toEqual([
      "send-keys",
      "-t",
      "%12",
      "weird ' \" ; `chars`",
      "Enter",
    ]);
  });
});
```

- [ ] **Step 2: Run — fail (worker doesn't exist)**

Run: `bun test src/__tests__/auq-bridge-worker-keys.test.ts -v`
Expected: FAIL.

- [ ] **Step 3: Create the worker**

Save to `~/.claude/hooks/claude-remote-auq-worker.ts`:

```typescript
#!/usr/bin/env bun
/**
 * AUQ-bridge worker. Spawned detached by claude-remote-auq-bridge.sh.
 * - POSTs the bridge request to the mobile-bridge bot.
 * - Long-polls for the answer.
 * - On answer: uses `tmux send-keys` to inject the answer into the CC TUI.
 * - On cancellation: exits silently.
 */

import { spawnSync } from "child_process";

interface WorkerInput {
  request_id: string;
  tool_use_id: string;
  session_id: string;
  cwd: string;
  tmux_pane: string;
  tool_input: { questions: Array<{ options: Array<{ label: string }> }> };
}

interface AnswerOk {
  status: "answered";
  answers: Array<{ question: string; answer: string }>;
}
interface AnswerCancelled {
  status: "cancelled";
  reason: string;
}
interface AnswerTimeout {
  status: "timeout";
}
type AnswerResp = AnswerOk | AnswerCancelled | AnswerTimeout;

const SECRET = process.env.RELAY_AUQ_SECRET ?? "";
const WEB_PORT = parseInt(process.env.WEB_PORT ?? "3000", 10);
const BASE = `http://localhost:${WEB_PORT}/api/auq-bridge`;
const AUTH = { Authorization: `Bearer ${SECRET}` };
const MAX_LONGPOLL_RETRIES = 3;

export function generateTmuxKeys(args: {
  pane: string;
  question: { options: Array<{ label: string }> };
  answer: string;
}): string[][] {
  const optionIndex = args.question.options.findIndex(
    (o) => o.label === args.answer,
  );
  if (optionIndex >= 0) {
    return [
      ["send-keys", "-t", args.pane, "Escape"],
      ["send-keys", "-t", args.pane, String(optionIndex + 1), "Enter"],
    ];
  }
  // Custom text: CC's TUI shows "N+1. Type something." after the user options.
  const typeOptionNumber = String(args.question.options.length + 1);
  return [
    ["send-keys", "-t", args.pane, "Escape"],
    ["send-keys", "-t", args.pane, typeOptionNumber, "Enter"],
    ["send-keys", "-t", args.pane, args.answer, "Enter"],
  ];
}

async function injectKeys(
  pane: string,
  question: { options: Array<{ label: string }> },
  answer: string,
): Promise<void> {
  if (!pane) return;
  const sequences = generateTmuxKeys({ pane, question, answer });
  for (const argv of sequences) {
    spawnSync("tmux", argv);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function readStdin(): Promise<string> {
  let buf = "";
  for await (const chunk of process.stdin) buf += String(chunk);
  return buf;
}

async function main(): Promise<void> {
  if (!SECRET) return;
  const inputRaw = await readStdin();
  const input = JSON.parse(inputRaw) as WorkerInput;

  // 1. POST to register the bridge.
  const postRes = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH },
    body: JSON.stringify({
      request_id: input.request_id,
      tool_use_id: input.tool_use_id,
      session_id: input.session_id,
      cwd: input.cwd,
      questions: input.tool_input.questions,
      tmux_pane: input.tmux_pane,
    }),
  }).catch(() => null);

  if (!postRes || !postRes.ok) return;

  // 2. Long-poll for the answer.
  let result: AnswerResp | null = null;
  for (let i = 0; i < MAX_LONGPOLL_RETRIES; i++) {
    const r = await fetch(`${BASE}/${input.request_id}/answer`, {
      headers: AUTH,
    }).catch(() => null);
    if (!r) break;
    if (r.status === 408) continue;
    if (!r.ok) break;
    result = (await r.json()) as AnswerResp;
    break;
  }

  // 3. Inject the answer via tmux.
  if (result?.status === "answered") {
    for (let i = 0; i < result.answers.length; i++) {
      const a = result.answers[i]!;
      const q = input.tool_input.questions[i]!;
      await injectKeys(input.tmux_pane, q, a.answer);
    }
  }
  // cancelled / timeout: exit silently — local TUI handles or was handled.
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("auq-bridge-worker:", err);
    process.exit(0); // never propagate errors to CC
  });
}
```

- [ ] **Step 4: Make executable**

```bash
chmod +x ~/.claude/hooks/claude-remote-auq-worker.ts
```

- [ ] **Step 5: Run tests**

Run: `bun test src/__tests__/auq-bridge-worker-keys.test.ts -v`
Expected: PASS, 3 tests.

- [ ] **Step 6: Run full canonical**

Run: `bun run typecheck && bun run test 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/__tests__/auq-bridge-worker-keys.test.ts
git commit -m "test(auq-bridge): worker tmux-keystroke generation"
```

---

## Task 13 — Register the hook in `~/.claude/settings.json` (GO-LIVE)

**Files:**

- Modify: `~/.claude/settings.json`

**This is the commit that turns the feature on.** Everything before this is dormant code.

- [ ] **Step 1: Confirm RELAY_AUQ_SECRET is set in your .env**

```bash
grep RELAY_AUQ_SECRET ~/Projects/Cursor/AHZ/claude-mobile-bridge/.env
```

If empty: generate one — `openssl rand -hex 32` — and add to `.env`.

- [ ] **Step 2: Confirm the bot picks it up**

```bash
cd ~/Projects/Cursor/AHZ/claude-mobile-bridge
bun run dev 2>&1 | head -20
```

Look for any error referencing RELAY_AUQ_SECRET. (If none, env var is loaded; kill the dev process before continuing.)

- [ ] **Step 3: Add the hook entry to settings.json**

Open `~/.claude/settings.json`. In the `hooks` object, add a new `PreToolUse` entry alongside the existing `Notification`, `SessionStart`, `Stop` entries:

```json
"PreToolUse": [
  {
    "matcher": "AskUserQuestion",
    "hooks": [
      {
        "type": "command",
        "command": "/Users/azaidi/.claude/hooks/claude-remote-auq-bridge.sh"
      }
    ]
  }
]
```

- [ ] **Step 4: Verify JSON is valid**

```bash
python3 -m json.tool ~/.claude/settings.json > /dev/null && echo "valid"
```

Expected: `valid`.

- [ ] **Step 5: Smoke-test the feature** (run the manual smoke checklist from the spec — items 1–10).

Don't commit yet; verify the feature works first.

- [ ] **Step 6: After successful smoke, no code commit needed for the settings.json edit (file lives outside the repo). Document in README via Task 14.**

---

## Task 14 — README + smoke checklist

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Add a feature bullet**

In the §Features section of the README, add after the "Interactive buttons" bullet:

```markdown
- **Remote-answerable AskUserQuestion** - Built-in `AskUserQuestion` cards relay to Telegram and the Web UI via a `PreToolUse` hook; tap an option on mobile (or answer locally) to resolve the desktop's clarifying question — first answer wins.
```

- [ ] **Step 2: Add an install snippet**

In §Quick Start (or a new §AUQ Remote Bridge section), add:

```markdown
### AskUserQuestion remote bridge (optional)

Generate a shared secret and add to `.env`:
```

RELAY_AUQ_SECRET=$(openssl rand -hex 32)

````

Add the PreToolUse hook to `~/.claude/settings.json`:
```json
"PreToolUse": [
  {
    "matcher": "AskUserQuestion",
    "hooks": [{ "type": "command", "command": "/Users/<you>/.claude/hooks/claude-remote-auq-bridge.sh" }]
  }
]
````

Copy `~/.claude/hooks/claude-remote-auq-bridge.sh` and `~/.claude/hooks/claude-remote-auq-worker.ts` from this repo's `hooks/` directory.

Built-in `AskUserQuestion` calls now surface in the bound Telegram topic AND the Web UI in parallel with the local TUI. First answer on any surface wins.

````

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document AUQ remote-bridge install"
````

---

## Final verification

- [ ] **Step 1: Full canonical green**

```bash
bun run typecheck && bun run test
```

Expected: typecheck clean, full canonical pass.

- [ ] **Step 2: Smoke checklist**

Re-run the 10-step smoke checklist from the spec. All steps PASS.

- [ ] **Step 3: PR**

```bash
gh pr create --base main --title "feat: AskUserQuestion remote bridge (TG + Web UI)" --body "$(cat <<'EOF'
## Summary
- Built-in `AskUserQuestion` is now answerable from Telegram and Web UI in parallel with the local TUI
- PreToolUse hook + detached worker + `/api/auq-bridge` endpoint
- JSONL `tool_result` observation as the cancellation signal when local wins
- Reuses existing `postQuestionToTelegram` + Web UI `ask_remote` SSE renderer

## Spec
docs/superpowers/specs/2026-05-11-auq-remote-bridge-design.md

## Plan
docs/superpowers/plans/2026-05-11-auq-remote-bridge.md

## Test plan
- [ ] 13 new tests pass (registry, handler, route, worker keys, hook subprocess)
- [ ] 834+ canonical green
- [ ] 10-step manual smoke (in spec) passed end-to-end

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Out-of-scope follow-ups (M2)

Listed in the spec under "M2 deferrals" — don't build now. Track separately if/when needed:

- `osascript`-based injection fallback for non-tmux sessions
- Worker restart-resilience (resume long-poll across bot restarts)
- Stale tmux pane id recovery
- Cross-host transport (bot + CC on different machines)
- Telemetry on mobile-vs-local win rates
