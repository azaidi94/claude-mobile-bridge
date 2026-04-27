/**
 * Unit tests for the tool-metrics aggregator.
 */

import "./ensure-test-env";
import { describe, expect, test, beforeEach } from "bun:test";

import {
  recordToolMetric,
  getToolMetrics,
  forgetTools,
  _resetForTests,
} from "../sessions/tool-metrics";

beforeEach(() => _resetForTests());

describe("tool-metrics: recordToolMetric + getToolMetrics", () => {
  test("returns empty list for unknown session", () => {
    expect(getToolMetrics("never-seen")).toEqual([]);
  });

  test("aggregates count, p50, p95, error rate for one tool", () => {
    const sid = "s1";
    const now = 1_700_000_000_000;
    for (let i = 0; i < 10; i++) {
      recordToolMetric(
        sid,
        { toolName: "Bash", durationMs: (i + 1) * 100, isError: i === 9 },
        now + i,
      );
    }
    const tools = getToolMetrics(sid, undefined, now + 100);
    expect(tools).toHaveLength(1);
    const bash = tools[0]!;
    expect(bash.toolName).toBe("Bash");
    expect(bash.count).toBe(10);
    // Sorted durations: 100,200,…,1000 — p50 floor(10*0.5)=5 → durations[5]=600
    expect(bash.p50Ms).toBe(600);
    // p95 floor(10*0.95)=9 → durations[9]=1000
    expect(bash.p95Ms).toBe(1000);
    expect(bash.errorPct).toBeCloseTo(10, 5);
    expect(bash.lastSeenMs).toBe(now + 9);
  });

  test("multiple tools sorted by p95 desc", () => {
    const sid = "s4";
    recordToolMetric(sid, {
      toolName: "Read",
      durationMs: 10,
      isError: false,
    });
    recordToolMetric(sid, {
      toolName: "Bash",
      durationMs: 1000,
      isError: false,
    });
    const tools = getToolMetrics(sid);
    expect(tools.map((t) => t.toolName)).toEqual(["Bash", "Read"]);
  });

  test("window prunes old samples on read", () => {
    const sid = "s2";
    const t0 = 2_000_000_000_000;
    recordToolMetric(
      sid,
      { toolName: "X", durationMs: 100, isError: false },
      t0,
    );
    recordToolMetric(
      sid,
      { toolName: "X", durationMs: 200, isError: false },
      t0 + 30 * 60 * 1000, // 30 min later
    );
    // Window 10 min from t0 + 60min → only the 30-min sample is in range.
    const tools = getToolMetrics(sid, 10 * 60 * 1000, t0 + 60 * 60 * 1000);
    // Both samples are older than the 10-min window from "now"
    expect(tools).toEqual([]);

    // Window covering both
    const all = getToolMetrics(sid, 24 * 60 * 60 * 1000, t0 + 60 * 60 * 1000);
    expect(all[0]!.count).toBe(2);
  });

  test("forgetTools clears the session", () => {
    recordToolMetric("s3", {
      toolName: "X",
      durationMs: 1,
      isError: false,
    });
    expect(getToolMetrics("s3")).toHaveLength(1);
    forgetTools("s3");
    expect(getToolMetrics("s3")).toEqual([]);
  });

  test("error rate counts only errored samples in the window", () => {
    const sid = "s5";
    const now = 3_000_000_000_000;
    recordToolMetric(
      sid,
      { toolName: "Bash", durationMs: 1, isError: false },
      now,
    );
    recordToolMetric(
      sid,
      { toolName: "Bash", durationMs: 1, isError: true },
      now + 1,
    );
    recordToolMetric(
      sid,
      { toolName: "Bash", durationMs: 1, isError: true },
      now + 2,
    );
    const tools = getToolMetrics(sid, undefined, now + 3);
    expect(tools[0]!.errorPct).toBeCloseTo(66.66, 1);
  });

  test("hard cap: never exceeds PER_TOOL_MAX_SAMPLES samples for one tool", () => {
    const sid = "s6";
    // Record 11_000 samples — implementation should clip to 10_000.
    for (let i = 0; i < 11_000; i++) {
      recordToolMetric(
        sid,
        { toolName: "Loop", durationMs: i, isError: false },
        i,
      );
    }
    // Use a window large enough to keep them all.
    const tools = getToolMetrics(sid, 24 * 60 * 60 * 1000 * 365, 11_000);
    expect(tools[0]!.count).toBeLessThanOrEqual(10_000);
    expect(tools[0]!.count).toBe(10_000);
  });

  test("zero samples in window returns no entry for that tool", () => {
    const sid = "s7";
    recordToolMetric(
      sid,
      { toolName: "Stale", durationMs: 1, isError: false },
      1000,
    );
    // Reading at now=999_999_999, with a 1ms window — sample is way outside.
    expect(getToolMetrics(sid, 1, 999_999_999)).toEqual([]);
  });
});
