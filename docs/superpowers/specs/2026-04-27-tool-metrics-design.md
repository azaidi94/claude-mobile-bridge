# Tool Metrics — Design Spec

**Status:** active
**Author:** initial pass 2026-04-27

## Problem

The bot tails Claude Code's JSONL stream and surfaces individual tool calls in the topic, but offers no per-tool aggregate view. When a session looks "stuck" (e.g. the toc-mapping-service incident on 2026-04-25), the only diagnostic path was raw log inspection. There's no way to answer:

- Which tools is this session actually using right now?
- How long is each one taking — is one tool the bottleneck?
- Which tools are erroring, at what rate?

Anthropic exposes much of this via OpenTelemetry, but enabling OTel requires `CLAUDE_CODE_ENABLE_TELEMETRY=1` and a Claude Code restart per session — which is invasive for already-running long-lived sessions. The JSONL stream we already tail carries the same primitives (tool_use blocks with timestamps + tool_result blocks with `is_error`), so a "good enough" version can ship today without touching Claude Code's environment.

## Goals

1. **Per-tool latency**: count, p50, p95, last-seen-ms per `(sessionId, toolName)` over a rolling 1h window.
2. **Per-tool error rate**: count of `tool_result.is_error === true` divided by total calls in the window.
3. **Mini App surface**: sortable table on a session detail view showing the above, polled every 5–10s.
4. **No new dependencies**: derived purely from JSONL. No OTel receiver, no Claude Code env-var changes.
5. **Zero impact on existing flows**: pure addition; no change to existing TailEvents or watch behavior.

## Non-goals

- OpenTelemetry ingestion (Phase 2).
- Cross-session aggregation (per-session only for now).
- Persistence across bot restarts (in-memory ring buffer; rebuilt naturally as sessions write new JSONL).
- Telegram surface (Mini App only for v1; Telegram `/status` extension is a future call).
- MCP-tool-prefix grouping (e.g. all `mcp__channel-relay__*` lumped together) — keep raw tool names; UI can group later.

## Data flow

```
~/.claude/projects/<sess>.jsonl
        │
        ▼
SessionTailer.parseLine
  - records tool_use → { toolUseId, name, startedAt }
  - on tool_result → looks up start, emits tool_metric event
        │
        ▼
handleTailEvent (watch.ts)
        │
        ▼
recordToolMetric(sessionId, ev) → src/sessions/tool-metrics.ts
        │  per-(sessionId, toolName) ring buffer (1h, 10k cap)
        ▼
GET /api/sessions/:id/tool-metrics
        │
        ▼
ToolMetricsPanel (Mini App)
```

## Event shape

New `TailEvent` variant:

```ts
{
  type: "tool_metric",
  content: "",           // unused but TailEvent requires it
  toolName: "Bash",      // existing field
  toolUseId: "toolu_…",  // existing field
  isError: false,        // existing field
  durationMs: 1234,      // new field
}
```

`TailEventType` gains `"tool_metric"`. The new field `durationMs?: number` is added to the `TailEvent` interface.

## Pairing

Tailer maintains a `pendingToolStarts: Map<toolUseId, { name, startedAtMs }>` parallel to the existing `toolUseRegistry` (which holds names only). Bound to 100 entries (same as `toolUseRegistry`) — when full, evict oldest. On `tool_result`, look up by `toolUseId`:

- Hit → emit `tool_metric` with `durationMs = now - startedAtMs`, `isError` from the result.
- Miss → emit nothing (orphaned tool_result, e.g. tail started mid-turn).

Start timestamp comes from the JSONL entry's `timestamp` field (ISO-8601 string parseable to ms). End timestamp is the tool_result entry's `timestamp`. We never use wall-clock `Date.now()` because that drifts when tailing historical JSONL on resume.

## Aggregator

`src/sessions/tool-metrics.ts`:

```ts
type ToolSample = { tsMs: number; durationMs: number; isError: boolean };
type SessionTools = Map<string /* toolName */, ToolSample[]>;
const store = new Map<string /* sessionId */, SessionTools>();

const WINDOW_MS = 60 * 60 * 1000; // 1h
const PER_TOOL_MAX_SAMPLES = 10_000; // safety cap per tool

export function recordToolMetric(
  sessionId: string,
  ev: { toolName: string; durationMs: number; isError: boolean },
): void;

export interface ToolMetricsAggregate {
  toolName: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  errorPct: number; // 0–100
  lastSeenMs: number; // wall clock
}

export function getToolMetrics(
  sessionId: string,
  windowMs?: number,
): ToolMetricsAggregate[];

export function forgetTools(sessionId: string): void;
```

Percentiles computed by sorting the windowed sample slice — fine for our scale (≤10k per tool).

## API

`GET /api/sessions/:sessionId/tool-metrics?window=3600000`

Response:

```json
{
  "sessionId": "f3e1022b-…",
  "windowMs": 3600000,
  "tools": [
    {
      "toolName": "Bash",
      "count": 42,
      "p50Ms": 320,
      "p95Ms": 4100,
      "errorPct": 7.1,
      "lastSeenMs": 1735305600000
    },
    {
      "toolName": "Read",
      "count": 18,
      "p50Ms": 12,
      "p95Ms": 38,
      "errorPct": 0,
      "lastSeenMs": 1735305580000
    }
  ]
}
```

Auth via existing `web/auth.ts` middleware (initData + loopback bypass).

## Mini App

New component `web/src/components/ToolMetricsPanel.tsx`:

- Accepts `sessionId` prop.
- Fetches `/api/sessions/:id/tool-metrics` every 7s.
- Renders a sortable table (default sort: p95 desc).
- Empty state: "No tool calls in the last hour."

Mount on the existing session detail view (or the Status page if there's no per-session detail yet — defer to implementation step).

## Lifecycle

- Sessions clean up via `forgetTools(sessionId)` when their watch is torn down (alongside the existing `forgetUsage` call from #34's context-usage feature).
- No persistence; bot restart drops the window. Acceptable because JSONL replay on next message rebuilds it naturally.

## Risks / open questions

- **Tail starts mid-turn**: tool_result without a paired tool_use is silently dropped. Acceptable — the metric for that turn is incomplete but later turns are fine.
- **Long-running tools**: Bash sleeps or Task subagents can run minutes. Bounded by `PER_TOOL_MAX_SAMPLES` and the 1h window.
- **JSONL clock vs wall clock**: We use JSONL timestamps for durations (correct under historical replay). `lastSeenMs` uses wall clock for "is this fresh" UI decisions.
- **No grouping by MCP prefix yet**: e.g. `mcp__channel-relay__reply` and `mcp__channel-relay__react` show separately. Add grouping in the UI later if it's noisy.
