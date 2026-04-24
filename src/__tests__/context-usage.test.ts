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
  getLastUsage,
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
  test("20% → 2 filled, 8 empty", () => {
    expect(contextBar(20)).toBe("●●○○○○○○○○");
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
    expect(formatContextLine(u)).toBe("🧠 ●○○○○○○○○○ 5% (50k/1M)");
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
    expect(getLastUsage("sid-1")).toEqual(u);
  });

  test("overwrites per session", () => {
    recordUsage("sid-2", { input_tokens: 1, output_tokens: 0 });
    recordUsage("sid-2", { input_tokens: 2, output_tokens: 0 });
    expect(getLastUsage("sid-2")?.input_tokens).toBe(2);
  });

  test("returns undefined for unknown session", () => {
    expect(getLastUsage("nope")).toBeUndefined();
  });
});
