# Context Usage Display — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show per-mirrored-session context usage in `/status`, and fire threshold-crossing Telegram notifications when usage passes configurable buckets (10/25/50%).

**Architecture:** `SessionTailer.parseLine` extracts `entry.message.usage` from assistant JSONL entries and emits a new `"usage"` `TailEvent`. A session-keyed registry in `src/sessions/context-usage.ts` holds the latest `TokenUsage` per session UUID. The `watch.ts` tailer-callback wrapper records usage and runs threshold-crossing notification logic (per-watch `lastNotifiedBucket`). `/status` renders a single context line from the registry. Settings gain `contextNotifyStep` cycling `off→10→25→50→off`.

**Tech Stack:** TypeScript, Bun test runner, grammY. Existing tailer/watcher scaffolding in `src/sessions/` and `src/handlers/watch.ts`.

**Spec:** `docs/superpowers/specs/2026-04-24-context-usage-design.md`

---

## File Plan

**Create:**

- `src/sessions/context-usage.ts` — pure helpers + session-keyed registry
- `src/__tests__/context-usage.test.ts` — unit tests for helpers + registry

**Modify:**

- `src/sessions/tailer.ts` — add `"usage"` variant to `TailEventType` + `TailEvent`; emit it from `parseLine`
- `src/__tests__/tailer.test.ts` — test usage emission
- `src/settings.ts` — add `contextNotifyStep` field, sanitize, getter
- `src/__tests__/settings.test.ts` — test sanitize + getter
- `src/handlers/watch.ts` — extend `WatchState` with `lastNotifiedBucket`; wire usage event in tailer callback wrapper at the three SessionTailer construction sites; threshold-crossing notification
- `src/handlers/commands.ts` — replace `📈 Xk in / Yk out` block with context line
- `src/handlers/settings.ts` — render context-notify row in body + keyboard
- `src/handlers/callback.ts` — handle `contextnotify` field in `handleSettingsCallback`

---

## Task 1: Add `"usage"` TailEvent variant and parsing

**Files:**

- Modify: `src/sessions/tailer.ts` — extend `TailEventType` (line 47-56), extend `TailEvent` interface (line 58-86), add emission in `parseLine` assistant branch (line 341-389)
- Modify: `src/__tests__/tailer.test.ts`

- [ ] **Step 1.1: Write failing test for usage extraction**

Add to `src/__tests__/tailer.test.ts` inside the `describe("tailer: parseLine", …)` block:

```ts
test("emits usage event from assistant entry", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 50_000,
        output_tokens: 40,
      },
    },
  });

  const events = tailer.parseLine(line);
  const usage = events.find((e) => e.type === "usage");
  expect(usage).toBeDefined();
  expect(usage!.usage).toEqual({
    input_tokens: 10,
    output_tokens: 40,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 50_000,
  });
});

test("no usage event when usage block missing", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "ok" }] },
  });
  const events = tailer.parseLine(line);
  expect(events.find((e) => e.type === "usage")).toBeUndefined();
});
```

- [ ] **Step 1.2: Run tests, confirm failure**

Run: `bun run test src/__tests__/tailer.test.ts`
Expected: both new tests fail — `usage` is not a valid `TailEventType`.

- [ ] **Step 1.3: Extend TailEventType and TailEvent interface**

In `src/sessions/tailer.ts`, replace the `TailEventType` declaration (line 47-56) with:

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
  | "hook_summary"
  | "usage";
```

In the same file, add an `import type { TokenUsage } from "../types";` near the top of the imports (line 8-13 area).

In the `TailEvent` interface (starting line 58), add a `usage` field:

```ts
export interface TailEvent {
  type: TailEventType;
  content: string;
  originChat?: string;
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
  /** For "usage" events: parsed assistant-turn token counts. */
  usage?: TokenUsage;
}
```

Note: `content` is required on every event; for `usage` events pass an empty string (we don't need display content, but the existing shape requires it).

- [ ] **Step 1.4: Emit the usage event in `parseLine`**

In `src/sessions/tailer.ts`, inside the `if (entry.type === "assistant")` branch (starts line 341). After the `for (const block of content)` loop finishes and before `return events;`, add:

```ts
const usage = entry.message?.usage;
if (
  usage &&
  typeof usage === "object" &&
  typeof usage.input_tokens === "number" &&
  typeof usage.output_tokens === "number"
) {
  events.push({
    type: "usage",
    content: "",
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens:
        typeof usage.cache_creation_input_tokens === "number"
          ? usage.cache_creation_input_tokens
          : undefined,
      cache_read_input_tokens:
        typeof usage.cache_read_input_tokens === "number"
          ? usage.cache_read_input_tokens
          : undefined,
    },
  });
}
```

- [ ] **Step 1.5: Run tests, confirm pass**

Run: `bun run test src/__tests__/tailer.test.ts`
Expected: all tailer tests pass.

- [ ] **Step 1.6: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 1.7: Commit**

```bash
git add src/sessions/tailer.ts src/__tests__/tailer.test.ts
git commit -m "feat(tailer): emit usage event from assistant entries"
```

---

## Task 2: Create `context-usage` module (helpers + registry)

**Files:**

- Create: `src/sessions/context-usage.ts`
- Create: `src/__tests__/context-usage.test.ts`

- [ ] **Step 2.1: Write failing tests**

Create `src/__tests__/context-usage.test.ts`:

```ts
/**
 * Unit tests for context-usage helpers + registry.
 */

import "./ensure-test-env";
import { describe, expect, test, beforeEach } from "bun:test";
import {
  CONTEXT_WINDOW,
  computeContextPct,
  contextBar,
  formatContextLine,
  checkThresholdCrossing,
  recordUsage,
  getContextState,
  _resetRegistryForTests,
} from "../sessions/context-usage";
import type { TokenUsage } from "../types";

describe("computeContextPct", () => {
  test("sums all four fields", () => {
    const u: TokenUsage = {
      input_tokens: 10_000,
      output_tokens: 100,
      cache_creation_input_tokens: 40_000,
      cache_read_input_tokens: 50_000,
    };
    // 100_000 / 1_000_000 = 10%
    expect(computeContextPct(u)).toBe(10);
  });

  test("treats missing cache fields as zero", () => {
    const u: TokenUsage = { input_tokens: 100_000, output_tokens: 0 };
    expect(computeContextPct(u)).toBe(10);
  });

  test("caps at 100%", () => {
    const u: TokenUsage = {
      input_tokens: CONTEXT_WINDOW * 2,
      output_tokens: 0,
    };
    expect(computeContextPct(u)).toBe(100);
  });
});

describe("contextBar", () => {
  test("0% → 10 empty", () => {
    expect(contextBar(0)).toBe("○○○○○○○○○○");
  });
  test("25% → 2 filled, 8 empty", () => {
    expect(contextBar(25)).toBe("●●○○○○○○○○");
  });
  test("100% → 10 filled", () => {
    expect(contextBar(100)).toBe("●●●●●●●●●●");
  });
  test("105% → still 10 filled (no overflow)", () => {
    expect(contextBar(105)).toBe("●●●●●●●●●●");
  });
});

describe("formatContextLine", () => {
  test("formats 50k usage as expected", () => {
    const u: TokenUsage = {
      input_tokens: 50_000,
      output_tokens: 0,
    };
    expect(formatContextLine(u)).toBe("🧠 ○○○○○○○○○○ 5% (50k/1M)");
  });
});

describe("checkThresholdCrossing", () => {
  test("step 0 never fires", () => {
    expect(checkThresholdCrossing(0, 99, 0)).toEqual({
      fire: false,
      bucket: 0,
    });
  });
  test("crosses 25 → 50 with step 25", () => {
    expect(checkThresholdCrossing(25, 52, 25)).toEqual({
      fire: true,
      bucket: 50,
    });
  });
  test("same bucket twice does not re-fire", () => {
    expect(checkThresholdCrossing(50, 55, 25)).toEqual({
      fire: false,
      bucket: 50,
    });
  });
  test("step 10 fires at 10% first time", () => {
    expect(checkThresholdCrossing(0, 12, 10)).toEqual({
      fire: true,
      bucket: 10,
    });
  });
});

describe("registry", () => {
  beforeEach(() => {
    _resetRegistryForTests();
  });

  test("stores and retrieves last usage", () => {
    const u: TokenUsage = { input_tokens: 1, output_tokens: 2 };
    recordUsage("sid-1", u);
    expect(getContextState("sid-1")?.lastUsage).toEqual(u);
  });

  test("overwrites per session", () => {
    recordUsage("sid-2", { input_tokens: 1, output_tokens: 0 });
    recordUsage("sid-2", { input_tokens: 2, output_tokens: 0 });
    expect(getContextState("sid-2")?.lastUsage.input_tokens).toBe(2);
  });

  test("returns undefined for unknown session", () => {
    expect(getContextState("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2.2: Run, confirm failure**

Run: `bun run test src/__tests__/context-usage.test.ts`
Expected: module not found.

- [ ] **Step 2.3: Implement `context-usage.ts`**

Create `src/sessions/context-usage.ts`:

```ts
/**
 * Context-window usage helpers + per-session registry.
 *
 * Assistant turns carry a `usage` block with input/output/cache tokens.
 * `current = input + cache_creation + cache_read` over `CONTEXT_WINDOW`
 * gives the same percentage the native Claude Code statusline displays.
 *
 * The registry stores only `lastUsage` per session — the per-watch
 * notification bucket lives on WatchState (src/handlers/watch.ts).
 */

import type { TokenUsage } from "../types";

export const CONTEXT_WINDOW = 1_000_000;

export interface ContextState {
  lastUsage: TokenUsage;
}

const registry = new Map<string, ContextState>();

export function recordUsage(sessionId: string, usage: TokenUsage): void {
  registry.set(sessionId, { lastUsage: usage });
}

export function getContextState(sessionId: string): ContextState | undefined {
  return registry.get(sessionId);
}

export function _resetRegistryForTests(): void {
  registry.clear();
}

export function computeContextPct(u: TokenUsage): number {
  const used =
    (u.input_tokens || 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  const pct = Math.round((used * 100) / CONTEXT_WINDOW);
  return Math.min(100, pct);
}

export function contextBar(pct: number): string {
  const filled = Math.min(10, Math.max(0, Math.floor(pct / 10)));
  return "●".repeat(filled) + "○".repeat(10 - filled);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function formatContextLine(u: TokenUsage): string {
  const pct = computeContextPct(u);
  const bar = contextBar(pct);
  const used =
    (u.input_tokens || 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  return `🧠 ${bar} ${pct}% (${formatTokens(used)}/${formatTokens(CONTEXT_WINDOW)})`;
}

/**
 * Returns the current bucket for `pct` at `step` granularity, and whether
 * it has grown past `prevBucket` (i.e. a new threshold was crossed).
 *
 * `step === 0` disables notifications. Caller is responsible for resetting
 * `prevBucket` to 0 when `pct` drops (e.g. after /compact).
 */
export function checkThresholdCrossing(
  prevBucket: number,
  pct: number,
  step: number,
): { fire: boolean; bucket: number } {
  if (step <= 0) return { fire: false, bucket: prevBucket };
  const bucket = Math.floor(pct / step) * step;
  return { fire: bucket > prevBucket, bucket };
}
```

- [ ] **Step 2.4: Run, confirm pass**

Run: `bun run test src/__tests__/context-usage.test.ts`
Expected: all tests pass.

- [ ] **Step 2.5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 2.6: Commit**

```bash
git add src/sessions/context-usage.ts src/__tests__/context-usage.test.ts
git commit -m "feat(sessions): context-usage helpers and per-session registry"
```

---

## Task 3: Add `contextNotifyStep` setting

**Files:**

- Modify: `src/settings.ts` — interface (line 27-39), sanitize (line 50-73), getter
- Modify: `src/__tests__/settings.test.ts`

- [ ] **Step 3.1: Write failing tests**

Append to `src/__tests__/settings.test.ts` inside the existing outer describe (or add a new `describe("contextNotifyStep", …)` at the bottom, following the same imports/setup already present in the file — do NOT invent new setup boilerplate; match what the file already does):

```ts
describe("contextNotifyStep", () => {
  test("sanitize accepts 0, 10, 25, 50", async () => {
    const path = resolveTempSettingsPath();
    await writeFile(path, JSON.stringify({ contextNotifyStep: 25 }));
    _reloadForTests();
    expect(getContextNotifyStep()).toBe(25);
  });

  test("sanitize rejects other values", async () => {
    const path = resolveTempSettingsPath();
    await writeFile(path, JSON.stringify({ contextNotifyStep: 42 }));
    _reloadForTests();
    expect(getContextNotifyStep()).toBe(0);
  });

  test("default is 0 when unset", async () => {
    const path = resolveTempSettingsPath();
    await writeFile(path, JSON.stringify({}));
    _reloadForTests();
    expect(getContextNotifyStep()).toBe(0);
  });
});
```

Add `getContextNotifyStep` to the import list at the top of the test file.

If the test file doesn't already expose `resolveTempSettingsPath`, reuse whatever helper the existing tests use to write a temp settings file — check the top of the file first. (Do not invent a new helper; match the existing pattern.)

- [ ] **Step 3.2: Run, confirm failure**

Run: `bun run test src/__tests__/settings.test.ts`
Expected: imports fail; `getContextNotifyStep` undefined.

- [ ] **Step 3.3: Extend `BridgeSettings`**

In `src/settings.ts`, inside the `BridgeSettings` interface (line 27-39), add:

```ts
export interface BridgeSettings {
  terminal?: TerminalApp;
  workingDir?: string;
  autoWatchOnSpawn?: boolean;
  defaultModel?: string;
  enablePinnedStatus?: boolean;
  groupMode?: boolean;
  /**
   * Context-usage notification step in percent.
   * 0 (default) = off. Valid non-zero values: 10, 25, 50.
   */
  contextNotifyStep?: number;
}
```

In the `sanitize` function (line 50-73), add before the `return out;`:

```ts
if (typeof o.contextNotifyStep === "number") {
  const allowed = [0, 10, 25, 50];
  if (allowed.includes(o.contextNotifyStep)) {
    out.contextNotifyStep = o.contextNotifyStep;
  }
}
```

At the bottom of the file (after `getGroupModeSetting`), add the getter:

```ts
export function getContextNotifyStep(): number {
  return ensure().contextNotifyStep ?? 0;
}
```

- [ ] **Step 3.4: Run, confirm pass**

Run: `bun run test src/__tests__/settings.test.ts`
Expected: new tests pass; no existing tests break.

- [ ] **Step 3.5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3.6: Commit**

```bash
git add src/settings.ts src/__tests__/settings.test.ts
git commit -m "feat(settings): add contextNotifyStep field"
```

---

## Task 4: Wire usage capture + notifications in `watch.ts`

**Files:**

- Modify: `src/handlers/watch.ts` — import registry + helpers; extend `WatchState` (line 138-160); wrap tailer callback at three sites (line 505, 632, 840) to handle `"usage"` events before delegating to `handleTailEvent`.

Note: `handleTailEvent` itself does **not** get a `case "usage"` — it's shared with the relay-bridge path (relay-bridge.ts:86) whose state does not carry `lastNotifiedBucket`. Usage handling stays in the watch.ts tailer-callback wrappers so it only fires for topic watches.

- [ ] **Step 4.1: Write failing test for threshold-crossing integration**

Add to `src/__tests__/watch.test.ts` (same file as existing watch tests). Match the existing test setup — if current tests stub `botApi.sendMessage` via `spyOn`, do the same; do not invent new mocks.

```ts
describe("context notify", () => {
  test("fires once at first crossing, silent on next same-bucket turn", async () => {
    // Set step = 25
    await saveSetting({ contextNotifyStep: 25 });

    // … use the existing test harness to feed two tailer "usage" events
    // (pct 30 then pct 35) to a WatchState, and assert botApi.sendMessage
    // was called exactly once with text matching /Context 30%/.

    // If the file already has a helper that constructs a WatchState and
    // invokes the tailer callback, use it. Otherwise, export a small helper
    // from watch.ts (see Step 4.4) and import it here.
  });
});
```

If no helper exists and it's cleaner to test the pure wrapper, split the wrapper into a named exported function `maybeNotifyContextCrossing(botApi, watchState, usage)` (Step 4.4 below) and test that directly instead. Match whichever style the rest of `watch.test.ts` uses.

- [ ] **Step 4.2: Run, confirm failure**

Run: `bun run test src/__tests__/watch.test.ts`
Expected: helper/import fails.

- [ ] **Step 4.3: Extend `WatchState`**

In `src/handlers/watch.ts`, inside the `WatchState` interface (line 138-160), add:

```ts
  /**
   * Highest context-usage threshold bucket already notified on this watch.
   * Zero means nothing fired yet (or bucket was reset after a compact).
   */
  lastNotifiedBucket?: number;
```

- [ ] **Step 4.4: Add `maybeNotifyContextCrossing` helper**

In `src/handlers/watch.ts`, above `handleTailEvent` (around line 1043, in the section `============== Tail Event Display ==============` but _outside_ of `handleTailEvent`), add:

```ts
import {
  recordUsage,
  computeContextPct,
  checkThresholdCrossing,
} from "../sessions/context-usage";
import { getContextNotifyStep } from "../settings";
```

(Place those imports at the top of the file with the other imports; the code block above is just the import list that should end up there.)

Then the helper function:

```ts
/**
 * For a mirrored-session watch: record the new usage and, if the notify
 * step is set, fire a one-shot Telegram message when a new threshold
 * bucket is crossed. Reset bucket to 0 if the observed pct dropped
 * below the last-notified bucket (compact / reset).
 */
export async function maybeNotifyContextCrossing(
  botApi: Api,
  state: WatchState,
  sessionId: string,
  usage: TokenUsage,
): Promise<void> {
  recordUsage(sessionId, usage);

  const step = getContextNotifyStep();
  if (step <= 0) return;

  const pct = computeContextPct(usage);
  let prev = state.lastNotifiedBucket ?? 0;
  if (pct < prev) {
    // Context shrank (e.g. /compact). Re-arm.
    prev = 0;
    state.lastNotifiedBucket = 0;
  }

  const { fire, bucket } = checkThresholdCrossing(prev, pct, step);
  if (!fire) return;

  state.lastNotifiedBucket = bucket;

  await botApi
    .sendMessage(state.chatId, `⚠️ Context ${pct}%`, {
      message_thread_id: state.threadId,
    })
    .catch((err) => warn(`context notify: ${err}`));
}
```

Ensure `TokenUsage` is imported (add `import type { TokenUsage } from "../types";` if not already present).

- [ ] **Step 4.5: Wire the wrapper at three SessionTailer construction sites**

Each of the three `new SessionTailer(...)` sites in `watch.ts` currently looks like:

```ts
const tailer = new SessionTailer(jsonlPath, (event: TailEvent) => {
  handleTailEvent(botApi, watchState, event, watchState.threadId);
  bridgeTailToSse(globalEventBus, sessionInfo.id, event); // or similar
});
```

At sites **line ~504**, **line ~631**, and **line ~839**, change the callback body to:

```ts
const tailer = new SessionTailer(jsonlPath, (event: TailEvent) => {
  if (event.type === "usage" && event.usage) {
    maybeNotifyContextCrossing(
      botApi,
      watchState,
      sessionInfo.id,
      event.usage,
    ).catch((err) => warn(`context notify: ${err}`));
  }
  handleTailEvent(botApi, watchState, event, watchState.threadId);
  bridgeTailToSse(globalEventBus, sessionInfo.id, event); // keep existing line
});
```

The exact `sessionInfo.id` variable name may differ at each site (`sessionInfo.id`, `sessionId`, etc.). Use whichever session-id variable is already in scope for that callback. Verify by reading each site before editing.

- [ ] **Step 4.6: Add `"usage"` no-op case to `handleTailEvent`**

Inside the `switch (event.type)` in `handleTailEvent` (line 1078), add a trivial case to suppress the default-fallthrough lint/TS-exhaustiveness noise:

```ts
case "usage":
  // Handled by the tailer-callback wrapper in watch.ts (maybeNotifyContextCrossing).
  // Shared handleTailEvent only renders; usage is registry-only.
  break;
```

- [ ] **Step 4.7: Run tests, confirm pass**

Run: `bun run test`
Expected: new context-notify test passes; existing watch tests still pass.

- [ ] **Step 4.8: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4.9: Commit**

```bash
git add src/handlers/watch.ts src/__tests__/watch.test.ts
git commit -m "feat(watch): record context usage and fire threshold notifications"
```

---

## Task 5: Show context line in `/status`

**Files:**

- Modify: `src/handlers/commands.ts` — replace `📈` block at line 953-958
- Modify: `src/__tests__/commands.test.ts`

- [ ] **Step 5.1: Write failing test**

Add to `src/__tests__/commands.test.ts` inside the existing `/status` describe block (search for `handleStatus` or `describe("handleStatus"` to find it):

```ts
test("includes context line when registry has usage", async () => {
  const sid = "abc-123";
  recordUsage(sid, {
    input_tokens: 50_000,
    output_tokens: 0,
  });

  // Stand up the test context — match the existing /status test harness;
  // it likely injects a session object with sessionId = sid, or uses
  // getActiveSession. Follow whatever the test file already does.

  const ctx = makeCtx({ userId: MOCK_ALLOWED_USERS[0]! });
  await handleStatus(ctx);
  const reply = (ctx.reply as unknown as { mock: { calls: unknown[][] } }).mock
    .calls[0]?.[0] as string;
  expect(reply).toContain("🧠");
  expect(reply).toContain("5%");
  expect(reply).toContain("(50k/1M)");
  expect(reply).not.toContain("📈");
});
```

Add `recordUsage` to the imports (from `../sessions/context-usage`).

- [ ] **Step 5.2: Run, confirm failure**

Run: `bun run test src/__tests__/commands.test.ts`
Expected: new test fails (still shows `📈` or omits context line).

- [ ] **Step 5.3: Replace `📈` block with context line**

In `src/handlers/commands.ts`, locate the block at line 952-958:

```ts
// Usage stats (compact)
if (session.lastUsage) {
  const u = session.lastUsage;
  const inK = Math.round((u.input_tokens || 0) / 1000);
  const outK = Math.round((u.output_tokens || 0) / 1000);
  lines.push(`📈 ${inK}k in / ${outK}k out`);
}
```

Replace with:

```ts
// Context window usage (mirrored-session registry)
const sid = activeSession?.info.id || session.sessionId;
if (sid) {
  const ctxState = getContextState(sid);
  if (ctxState) {
    lines.push(formatContextLine(ctxState.lastUsage));
  }
}
```

Add imports at the top of `src/handlers/commands.ts` (join with existing `../sessions/...` imports if any):

```ts
import { getContextState, formatContextLine } from "../sessions/context-usage";
```

- [ ] **Step 5.4: Run, confirm pass**

Run: `bun run test src/__tests__/commands.test.ts`
Expected: new test passes; no existing tests break.

- [ ] **Step 5.5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5.6: Commit**

```bash
git add src/handlers/commands.ts src/__tests__/commands.test.ts
git commit -m "feat(status): show context usage line, drop unused in/out counters"
```

---

## Task 6: Settings panel UI — body + keyboard row

**Files:**

- Modify: `src/handlers/settings.ts` — `renderSettingsBody` (line 46-81) + `renderSettingsKeyboard` (line 83-99)
- Modify: `src/__tests__/settings-handler.test.ts`

- [ ] **Step 6.1: Write failing test**

In `src/__tests__/settings-handler.test.ts` (match the file's existing style):

```ts
test("renderSettingsBody includes context notify row", () => {
  _reloadForTests();
  const body = renderSettingsBody();
  expect(body).toContain("Context notify");
  expect(body).toContain("off");
});

test("renderSettingsBody shows selected percentage", async () => {
  await saveSetting({ contextNotifyStep: 25 });
  const body = renderSettingsBody();
  expect(body).toContain("25%");
});

test("renderSettingsKeyboard includes context notify button", () => {
  const kb = renderSettingsKeyboard();
  const allButtons = kb.inline_keyboard.flat();
  expect(
    allButtons.some((b) => b.callback_data === "set:edit:contextnotify"),
  ).toBe(true);
});
```

Imports at the top of that test file should include `renderSettingsBody`, `renderSettingsKeyboard`, `saveSetting`, `_reloadForTests`.

- [ ] **Step 6.2: Run, confirm failure**

Run: `bun run test src/__tests__/settings-handler.test.ts`
Expected: new tests fail.

- [ ] **Step 6.3: Add row to `renderSettingsBody`**

In `src/handlers/settings.ts`, inside `renderSettingsBody()`:

1. Add the import at the top with the other settings imports:

```ts
import {
  getTerminal,
  getWorkingDir,
  getAutoWatchOnSpawn,
  getEnablePinnedStatus,
  getContextNotifyStep,
  getOverrides,
} from "../settings";
```

2. Above the closing `].join("\n");` (after the `📌 Pinned Status` line), add:

```ts
    "",
    "━ Notifications ━",
    `🧠 Context notify: <code>${formatNotifyStep(
      getContextNotifyStep(),
    )}</code>${marker("contextNotifyStep")}`,
```

3. Add a tiny helper near the top of the file (below `truncPath`):

```ts
function formatNotifyStep(n: number): string {
  return n === 0 ? "off" : `every ${n}%`;
}
```

- [ ] **Step 6.4: Add keyboard button**

In `renderSettingsKeyboard()`, extend the last row (or add a new row) so the returned object includes:

```ts
[{ text: "🧠 Context notify", callback_data: "set:edit:contextnotify" }],
```

Final shape:

```ts
return {
  inline_keyboard: [
    [
      { text: "🖥 Terminal", callback_data: "set:edit:terminal" },
      { text: "📁 Working dir", callback_data: "set:edit:workdir" },
    ],
    [
      { text: "👁 Auto-watch", callback_data: "set:edit:autowatch" },
      { text: "🤖 Model", callback_data: "set:edit:model" },
    ],
    [{ text: "📌 Pinned Status", callback_data: "set:edit:pinnedstatus" }],
    [{ text: "🧠 Context notify", callback_data: "set:edit:contextnotify" }],
  ],
};
```

- [ ] **Step 6.5: Run, confirm pass**

Run: `bun run test src/__tests__/settings-handler.test.ts`
Expected: new tests pass.

- [ ] **Step 6.6: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6.7: Commit**

```bash
git add src/handlers/settings.ts src/__tests__/settings-handler.test.ts
git commit -m "feat(settings-ui): context-notify row"
```

---

## Task 7: Callback handler — cycle `contextnotify`

**Files:**

- Modify: `src/handlers/callback.ts` — `handleSettingsCallback` at line 752

- [ ] **Step 7.1: Write failing test**

In `src/__tests__/settings-handler.test.ts` (same file as Task 6):

```ts
test("cycle: off → 10 → 25 → 50 → off", async () => {
  _reloadForTests();
  // Start: unset → treated as 0 (off)
  const make = () => {
    const ctx = makeFakeCtx(); // whatever helper the existing tests use
    return ctx;
  };

  await handleSettingsCallback(make(), 1, "set:edit:contextnotify");
  expect(getContextNotifyStep()).toBe(10);

  await handleSettingsCallback(make(), 1, "set:edit:contextnotify");
  expect(getContextNotifyStep()).toBe(25);

  await handleSettingsCallback(make(), 1, "set:edit:contextnotify");
  expect(getContextNotifyStep()).toBe(50);

  await handleSettingsCallback(make(), 1, "set:edit:contextnotify");
  expect(getContextNotifyStep()).toBe(0);
});

test("reset clears override", async () => {
  _reloadForTests();
  await saveSetting({ contextNotifyStep: 25 });
  await handleSettingsCallback(makeFakeCtx(), 1, "set:reset:contextnotify");
  expect(getContextNotifyStep()).toBe(0);
});
```

If `handleSettingsCallback` isn't already exported from `callback.ts`, export it (Step 7.3 handles this). If `makeFakeCtx` doesn't already exist in the test file, use whatever ctx-construction helper the existing callback tests already use — do not invent a new one.

- [ ] **Step 7.2: Run, confirm failure**

Run: `bun run test src/__tests__/settings-handler.test.ts`
Expected: new cycle tests fail.

- [ ] **Step 7.3: Add `contextnotify` branch to `handleSettingsCallback`**

In `src/handlers/callback.ts`, inside `handleSettingsCallback`'s `if (action === "edit")` block (around line 760-860) — add a new branch before `await ctx.answerCallbackQuery({ text: "Unknown field" });` at line 859:

```ts
if (field === "contextnotify") {
  // Cycle: 0 (off) → 10 → 25 → 50 → 0
  const current = getContextNotifyStep();
  const order = [0, 10, 25, 50];
  const idx = order.indexOf(current);
  const nextIdx = idx === -1 ? 1 : (idx + 1) % order.length;
  const next = order[nextIdx]!;
  await saveSetting({ contextNotifyStep: next === 0 ? undefined : next });
  await rerenderSettingsPanel(ctx);
  const label = next === 0 ? "off" : `every ${next}%`;
  await ctx.answerCallbackQuery({ text: `Context notify: ${label}` });
  return;
}
```

Inside the `if (action === "reset")` block (around line 887-907), add a branch:

```ts
} else if (field === "contextnotify") {
  await saveSetting({ contextNotifyStep: undefined });
}
```

(Place it alongside the other `else if` branches for `autowatch`, `pinnedstatus`, etc.)

At the top of `callback.ts`, add to the imports from `../settings`:

```ts
import {
  // existing imports …
  getContextNotifyStep,
} from "../settings";
```

If `handleSettingsCallback` is not already exported, change its declaration from `async function handleSettingsCallback(` to `export async function handleSettingsCallback(`.

- [ ] **Step 7.4: Run, confirm pass**

Run: `bun run test src/__tests__/settings-handler.test.ts`
Expected: all new tests pass.

- [ ] **Step 7.5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 7.6: Full test suite**

Run: `bun run test`
Expected: everything green.

- [ ] **Step 7.7: Commit**

```bash
git add src/handlers/callback.ts src/__tests__/settings-handler.test.ts
git commit -m "feat(settings): cycle contextNotifyStep off→10→25→50"
```

---

## Task 8: Manual verification

- [ ] **Step 8.1: Start the bot**

Run: `bun run dev`
Leave it running.

- [ ] **Step 8.2: Exercise `/status`**

In Telegram, open any topic that's watching an active desktop session. Send `/status`. Expected: the reply includes a line like `🧠 ●●○○○○○○○○ 15% (147k/1M)`. If usage hasn't landed yet, the line is omitted — send a new prompt to the mirrored session, wait for one assistant turn, then retry.

- [ ] **Step 8.3: Exercise `/settings`**

Send `/settings` in DM. Expected: the panel shows the new row `🧠 Context notify: off (default)`.

Tap the new button four times. Expected: cycles through `every 10%` → `every 25%` → `every 50%` → `off`.

- [ ] **Step 8.4: Trigger a notification**

Set context notify to 10% (or lowest value below current session usage). Send any message to the mirrored session to trigger a turn. Expected: a message `⚠️ Context NN%` appears in the topic where the watch is running, for the first turn whose usage crosses the next bucket.

- [ ] **Step 8.5: Confirm no spam**

Send several more mirrored-session turns without crossing the next bucket. Expected: no additional notifications.

- [ ] **Step 8.6: Stop the bot**

Ctrl-C the dev server.

---

## Task 9: Run `/simplify`

- [ ] **Step 9.1: Invoke the simplify skill**

Invoke `Skill` with `skill: "simplify"`. It reviews all changed code on this branch for reuse, quality, and efficiency, and applies fixes.

- [ ] **Step 9.2: Re-run typecheck + tests after any fixes**

Run: `bun run typecheck && bun run test`
Expected: all green.

- [ ] **Step 9.3: Commit any simplify-driven changes**

If simplify produced diffs:

```bash
git add -u
git commit -m "refactor: simplify context-usage implementation"
```

If no diffs, skip this step.

---

## Out of scope reminder

- SDK path (`src/session.ts`): left untouched.
- No pinned-status display of context.
- No per-session window override.
- No persistence of `lastNotifiedBucket` across bot restarts.
