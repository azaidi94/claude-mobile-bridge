/**
 * Per-session tool-metrics aggregator.
 *
 * Records (toolName, durationMs, isError) samples emitted by SessionTailer's
 * tool_use → tool_result pairing logic, and exposes per-tool aggregates
 * (count, p50, p95, error %) over a configurable rolling window.
 *
 * In-memory only — bot restart drops the window. JSONL replay on resume
 * naturally rebuilds it from disk.
 */

export interface ToolMetricSample {
  /** Wall-clock timestamp of the sample (ms since epoch). */
  tsMs: number;
  /** tool_use → tool_result latency in ms. */
  durationMs: number;
  /** True when the result reported `is_error: true`. */
  isError: boolean;
}

export interface ToolMetricsAggregate {
  toolName: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  /** Error percentage (0–100) within the window. */
  errorPct: number;
  /** Wall-clock timestamp of the most recent sample in the window. */
  lastSeenMs: number;
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1h
const PER_TOOL_MAX_SAMPLES = 10_000;

const store = new Map<
  string /* sessionId */,
  Map<string /* toolName */, ToolMetricSample[]>
>();

/**
 * Record a single tool execution sample for a session. Caller passes
 * `nowMs` only in tests; production callers omit it.
 */
export function recordToolMetric(
  sessionId: string,
  ev: { toolName: string; durationMs: number; isError: boolean },
  nowMs: number = Date.now(),
): void {
  if (!sessionId || !ev.toolName) return;
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
  // Hard-cap by count so a runaway session can't grow the buffer
  // unboundedly. Window-based pruning happens lazily in getToolMetrics.
  if (buf.length > PER_TOOL_MAX_SAMPLES) {
    buf.splice(0, buf.length - PER_TOOL_MAX_SAMPLES);
  }
}

/**
 * Aggregate per-tool metrics for a session within the given window.
 * Returns tools sorted by p95Ms desc (the slowest first) — most useful
 * default ordering for the Mini App table.
 */
export function getToolMetrics(
  sessionId: string,
  windowMs: number = DEFAULT_WINDOW_MS,
  nowMs: number = Date.now(),
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
    out.push({
      toolName,
      count: slice.length,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      errorPct: (errors / slice.length) * 100,
      lastSeenMs: slice[slice.length - 1]!.tsMs,
    });
  }
  out.sort((a, b) => b.p95Ms - a.p95Ms);
  return out;
}

/**
 * Drop a session's metric history. Called from watch teardown so a
 * killed/offline session doesn't leak its buffers.
 */
export function forgetTools(sessionId: string): void {
  store.delete(sessionId);
}

/** Pick the value at the given quantile from a pre-sorted array. */
function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * q));
  return sortedAsc[idx] ?? 0;
}

/** Test helper — drops the entire store. */
export function _resetForTests(): void {
  store.clear();
}
