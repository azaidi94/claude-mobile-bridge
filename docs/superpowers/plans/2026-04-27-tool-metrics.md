# Tool Metrics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-tool latency/error/count aggregation surfaced on the Mini App, derived from JSONL `tool_use → tool_result` pairs in real time. No Claude Code restart required.

**Architecture:** `SessionTailer.parseLine` pairs `tool_use` start timestamps with their `tool_result` completions and emits a new `"tool_metric"` `TailEvent`. A session-keyed registry in `src/sessions/tool-metrics.ts` holds a rolling 1h ring buffer per `(sessionId, toolName)` and computes count/p50/p95/error% on read. The `watch.ts` tailer-callback wrapper records each metric (mirrors `recordUsage` from #34). A new web route exposes the aggregates; the Mini App polls every 7s.

**Tech Stack:** TypeScript, Bun test runner, Hono, React (Mini App).

**Spec:** `docs/superpowers/specs/2026-04-27-tool-metrics-design.md`

---

## File Plan

**Create:**

- `src/sessions/tool-metrics.ts` — registry + aggregation helpers
- `src/__tests__/tool-metrics.test.ts` — unit tests for aggregation
- `src/web/sessions/tool-metrics.ts` — route handler
- `src/__tests__/web-tool-metrics-route.test.ts` — route tests
- `web/src/components/ToolMetricsPanel.tsx` — Mini App widget

**Modify:**

- `src/sessions/tailer.ts` — add `"tool_metric"` to `TailEventType`; add `durationMs?: number` to `TailEvent`; pair tool_use → tool_result and emit
- `src/__tests__/tailer.test.ts` — test pairing emission and orphan handling
- `src/handlers/watch.ts` — call `recordToolMetric` on `tool_metric` events; call `forgetTools` on watch teardown
- `src/web/server.ts` — mount new route
- `web/src/api.ts` (or wherever the API client lives) — add `fetchToolMetrics`

---

## Task 1: Add `"tool_metric"` TailEvent variant + pairing in tailer

**Files:**

- Modify: `src/sessions/tailer.ts` — extend `TailEventType` (line 47-56), extend `TailEvent` interface (line 58-86), add pendingToolStarts Map field on `SessionTailer`, emit `tool_metric` from `parseLine` `tool_result` branch
- Modify: `src/__tests__/tailer.test.ts`

- [ ] **Step 1.1: Write failing tests for pairing**

```ts
test("emits tool_metric pairing tool_use with tool_result", () => {
  const tailer = new SessionTailer("/dev/null", () => {});
  const useLine = JSON.stringify({
    type: "assistant",
    timestamp: "2026-04-27T10:00:00.000Z",
    message: {
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
    },
  });
  const resultLine = JSON.stringify({
    type: "user",
    timestamp: "2026-04-27T10:00:01.500Z",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "ok",
          is_error: false,
        },
      ],
    },
  });

  tailer.parseLine(useLine);
  const events = tailer.parseLine(resultLine);
  const metric = events.find((e) => e.type === "tool_metric");
  expect(metric).toBeDefined();
  expect(metric!.toolName).toBe("Bash");
  expect(metric!.durationMs).toBe(1500);
  expect(metric!.isError).toBe(false);
  expect(metric!.toolUseId).toBe("toolu_1");
});

test("orphan tool_result emits no tool_metric", () => {
  const tailer = new SessionTailer("/dev/null", () => {});
  const resultLine = JSON.stringify({
    type: "user",
    timestamp: "2026-04-27T10:00:00.000Z",
    message: {
      content: [{ type: "tool_result", tool_use_id: "unknown", content: "ok" }],
    },
  });
  const events = tailer.parseLine(resultLine);
  expect(events.find((e) => e.type === "tool_metric")).toBeUndefined();
});

test("pendingToolStarts is bounded", () => {
  const tailer = new SessionTailer("/dev/null", () => {});
  for (let i = 0; i < 150; i++) {
    tailer.parseLine(
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-27T10:00:00.000Z",
        message: {
          content: [{ type: "tool_use", id: `t${i}`, name: "X", input: {} }],
        },
      }),
    );
  }
  // Oldest entries evicted; 0..49 should miss, 50..149 should hit.
  const ev = tailer
    .parseLine(
      JSON.stringify({
        type: "user",
        timestamp: "2026-04-27T10:00:00.001Z",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t0", content: "" }],
        },
      }),
    )
    .find((e) => e.type === "tool_metric");
  expect(ev).toBeUndefined();
});
```

- [ ] **Step 1.2: Implement pairing**

In `SessionTailer`:

- Add private `pendingToolStarts = new Map<string, { name: string; startedAtMs: number }>();` field with `MAX = 100`.
- In `parseLine`'s assistant `tool_use` block, after `events.push({ type: "tool", … })`, also `pendingToolStarts.set(block.id, { name: block.name, startedAtMs: parseEntryTs(entry) })`. Evict oldest when size > MAX.
- In `parseLine`'s user `tool_result` block (where `resultEvents.push(...)` happens), after pushing the `tool_result` event, look up `pendingToolStarts.get(toolUseId)`. If hit, push a new `tool_metric` event and `pendingToolStarts.delete(toolUseId)`.
- New helper `parseEntryTs(entry: { timestamp?: string }): number` — `entry.timestamp ? Date.parse(entry.timestamp) : Date.now()`.
- Extend `TailEventType` with `"tool_metric"`. Extend `TailEvent` with `durationMs?: number`.

- [ ] **Step 1.3: Run tests**

```bash
bun test src/__tests__/tailer.test.ts
```

---

## Task 2: Aggregator module

**Files:**

- Create: `src/sessions/tool-metrics.ts`
- Create: `src/__tests__/tool-metrics.test.ts`

- [ ] **Step 2.1: Write failing tests**

```ts
import { describe, expect, test, beforeEach } from "bun:test";
import {
  recordToolMetric,
  getToolMetrics,
  forgetTools,
  _resetForTests,
} from "../sessions/tool-metrics";

beforeEach(() => _resetForTests());

test("aggregates count/p50/p95/error", () => {
  const sid = "s1";
  for (let i = 0; i < 10; i++) {
    recordToolMetric(sid, {
      toolName: "Bash",
      durationMs: (i + 1) * 100,
      isError: i === 9,
    });
  }
  const [bash] = getToolMetrics(sid);
  expect(bash.toolName).toBe("Bash");
  expect(bash.count).toBe(10);
  expect(bash.p50Ms).toBe(500); // approx median of 100..1000
  expect(bash.p95Ms).toBe(1000);
  expect(bash.errorPct).toBeCloseTo(10, 0);
});

test("window prunes old samples", () => {
  const sid = "s2";
  // older than window — would need to mock Date.now or expose tsMs override
  // (via _recordWithTsForTests helper)
});

test("forgetTools removes session", () => {
  recordToolMetric("s3", { toolName: "X", durationMs: 1, isError: false });
  forgetTools("s3");
  expect(getToolMetrics("s3")).toEqual([]);
});

test("multiple tools sorted by p95 desc", () => {
  const sid = "s4";
  recordToolMetric(sid, { toolName: "A", durationMs: 10, isError: false });
  recordToolMetric(sid, { toolName: "B", durationMs: 1000, isError: false });
  const tools = getToolMetrics(sid);
  expect(tools[0]!.toolName).toBe("B");
});
```

- [ ] **Step 2.2: Implement**

```ts
// src/sessions/tool-metrics.ts
export type ToolMetricSample = {
  tsMs: number;
  durationMs: number;
  isError: boolean;
};
export interface ToolMetricsAggregate {
  toolName: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  errorPct: number;
  lastSeenMs: number;
}

const WINDOW_MS = 60 * 60 * 1000;
const PER_TOOL_MAX_SAMPLES = 10_000;
const store = new Map<string, Map<string, ToolMetricSample[]>>();

export function recordToolMetric(
  sessionId: string,
  ev: { toolName: string; durationMs: number; isError: boolean },
  nowMs = Date.now(),
): void {
  let session = store.get(sessionId);
  if (!session) {
    session = new Map();
    store.set(sessionId, session);
  }
  let buf = session.get(ev.toolName);
  if (!buf) {
    buf = [];
    session.set(ev.toolName, buf);
  }
  buf.push({ tsMs: nowMs, durationMs: ev.durationMs, isError: ev.isError });
  // Prune by count (cheap; window prune happens on read).
  if (buf.length > PER_TOOL_MAX_SAMPLES) {
    buf.splice(0, buf.length - PER_TOOL_MAX_SAMPLES);
  }
}

export function getToolMetrics(
  sessionId: string,
  windowMs = WINDOW_MS,
  nowMs = Date.now(),
): ToolMetricsAggregate[] {
  const session = store.get(sessionId);
  if (!session) return [];
  const cutoff = nowMs - windowMs;
  const out: ToolMetricsAggregate[] = [];
  for (const [toolName, buf] of session) {
    const slice = buf.filter((s) => s.tsMs >= cutoff);
    if (slice.length === 0) continue;
    const durations = slice.map((s) => s.durationMs).sort((a, b) => a - b);
    const errors = slice.filter((s) => s.isError).length;
    const p50 = durations[Math.floor(durations.length * 0.5)] ?? 0;
    const p95 =
      durations[
        Math.min(durations.length - 1, Math.floor(durations.length * 0.95))
      ] ?? 0;
    out.push({
      toolName,
      count: slice.length,
      p50Ms: p50,
      p95Ms: p95,
      errorPct: (errors / slice.length) * 100,
      lastSeenMs: slice[slice.length - 1]!.tsMs,
    });
  }
  out.sort((a, b) => b.p95Ms - a.p95Ms);
  return out;
}

export function forgetTools(sessionId: string): void {
  store.delete(sessionId);
}

export function _resetForTests(): void {
  store.clear();
}
```

- [ ] **Step 2.3: Run tests**

---

## Task 3: Wire aggregator into watch handler

**Files:**

- Modify: `src/handlers/watch.ts` — handleTailEvent + cleanupWatch

- [ ] **Step 3.1: Record on tool_metric event**

In `handleTailEvent` (after the existing watchdog bookkeeping, before the typing block, similar to how `usage` events feed `recordUsage` in the post-#34 code):

```ts
if (
  event.type === "tool_metric" &&
  event.toolName &&
  typeof event.durationMs === "number"
) {
  if (isWatchState(state)) {
    recordToolMetric(state.sessionId, {
      toolName: event.toolName,
      durationMs: event.durationMs,
      isError: Boolean(event.isError),
    });
  }
  return; // tool_metric has no UI side effect in watch
}
```

- [ ] **Step 3.2: Cleanup on watch teardown**

Find `forgetUsage(state.sessionId)` call (added by #34 in `cleanupWatch`/`stopWatching`). Add `forgetTools(state.sessionId)` next to it.

- [ ] **Step 3.3: Import**

`import { recordToolMetric, forgetTools } from "../sessions/tool-metrics";`

---

## Task 4: Web API route

**Files:**

- Create: `src/web/sessions/tool-metrics.ts`
- Create: `src/__tests__/web-tool-metrics-route.test.ts`
- Modify: `src/web/server.ts`

- [ ] **Step 4.1: Write route test**

Mirror `src/__tests__/web-sessions-history-route.test.ts` shape:

```ts
test("GET /api/sessions/:id/tool-metrics returns aggregates", async () => {
  // record some metrics for "test-sess"
  // make a Hono fetch with valid auth
  // assert JSON shape
});

test("rejects unauthenticated", async () => { … });
test("empty session returns empty tools array", async () => { … });
```

- [ ] **Step 4.2: Implement route**

```ts
// src/web/sessions/tool-metrics.ts
import type { Hono } from "hono";
import { getToolMetrics } from "../../sessions/tool-metrics";

export function mountToolMetricsRoute(app: Hono): void {
  app.get("/api/sessions/:id/tool-metrics", (c) => {
    const id = c.req.param("id");
    const window = Number(c.req.query("window") ?? 3_600_000);
    const tools = getToolMetrics(id, isFinite(window) ? window : 3_600_000);
    return c.json({ sessionId: id, windowMs: window, tools });
  });
}
```

- [ ] **Step 4.3: Mount in server.ts**

---

## Task 5: Mini App widget

**Files:**

- Create: `web/src/components/ToolMetricsPanel.tsx`
- Modify: `web/src/api.ts` (or equivalent) — add `fetchToolMetrics`
- Modify: wherever the session detail / status surface lives, render `<ToolMetricsPanel sessionId=… />`

- [ ] **Step 5.1: API client**

```ts
export async function fetchToolMetrics(
  sessionId: string,
  windowMs = 3_600_000,
) {
  return apiGet<ToolMetricsResponse>(
    `/api/sessions/${sessionId}/tool-metrics?window=${windowMs}`,
  );
}
```

- [ ] **Step 5.2: Component**

Sortable table with columns: Tool, Count, p50 (ms), p95 (ms), Error %, Last seen. Default sort by p95 desc. Polls every 7s with `useEffect` + `setInterval`. Empty state.

- [ ] **Step 5.3: Mount on existing page**

Identify the right page (session detail vs status). Drop a check-the-page step here once we open the file.

---

## Task 6: Verification

- [ ] `bun run typecheck` clean
- [ ] `bun run test` clean
- [ ] Manual: bot restart with this branch, observe Mini App tool metrics widget populate as messages arrive in topics
- [ ] Manual: confirm `forgetTools` runs when a session goes offline (no leak)

---

## Notes for reviewer

- This is Phase 1 of a two-phase observability push (the Phase 2 OTel ingest is a follow-up PR).
- No Claude Code env-var changes; works with already-running sessions.
- `recordToolMetric`'s `nowMs` parameter is for testability — production callers omit it.
