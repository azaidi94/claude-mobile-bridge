import { useEffect, useState } from "react";
import { api, type ToolMetricsAggregate } from "../api";

interface ToolMetricsPanelProps {
  sessionId: string;
  sessionName?: string;
  /** Polling interval in ms. Default 7s — matches the JSONL write cadence. */
  pollMs?: number;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function timeSince(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/**
 * Per-tool latency / error / count table for a session, fed by the JSONL
 * tailer's tool_use → tool_result pairing. Polls /api/sessions/:id/tool-metrics
 * on a fixed cadence; drops to an empty-state when the session has had no
 * tool calls in the window.
 */
export function ToolMetricsPanel({
  sessionId,
  sessionName,
  pollMs = 7000,
}: ToolMetricsPanelProps) {
  const [tools, setTools] = useState<ToolMetricsAggregate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = () => {
      api
        .getToolMetrics(sessionId)
        .then((res) => {
          if (cancelled) return;
          setTools(res.tools);
          setError(null);
          setLoading(false);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : "fetch failed");
          setLoading(false);
        });
    };
    fetchOnce();
    const id = setInterval(fetchOnce, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId, pollMs]);

  return (
    <div>
      <div className="text-xs text-terminal-muted uppercase tracking-widest mb-2">
        Tool metrics{sessionName ? ` · ${sessionName}` : ""}
      </div>
      {loading && (
        <p className="text-terminal-muted text-xs">Loading...</p>
      )}
      {error && (
        <p className="text-yellow-400 text-xs">Failed to load: {error}</p>
      )}
      {!loading && !error && tools.length === 0 && (
        <p className="text-terminal-muted text-xs">
          No tool calls in the last hour.
        </p>
      )}
      {tools.length > 0 && (
        <div className="space-y-1">
          <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-2 text-[10px] uppercase tracking-widest text-terminal-muted py-1 border-b border-terminal-border">
            <span>Tool</span>
            <span className="text-right">Count</span>
            <span className="text-right">p50</span>
            <span className="text-right">p95</span>
            <span className="text-right">Err%</span>
          </div>
          {tools.map((t) => (
            <div
              key={t.toolName}
              className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-2 text-xs font-mono py-1 border-b border-terminal-border last:border-0"
              title={`Last seen ${timeSince(t.lastSeenMs)}`}
            >
              <span className="text-terminal-text truncate">
                {t.toolName}
              </span>
              <span className="text-right text-terminal-muted">
                {t.count}
              </span>
              <span className="text-right text-terminal-green">
                {formatMs(t.p50Ms)}
              </span>
              <span
                className={`text-right ${
                  t.p95Ms > 5000
                    ? "text-yellow-400"
                    : "text-terminal-green"
                }`}
              >
                {formatMs(t.p95Ms)}
              </span>
              <span
                className={`text-right ${
                  t.errorPct > 0 ? "text-yellow-400" : "text-terminal-muted"
                }`}
              >
                {t.errorPct.toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
