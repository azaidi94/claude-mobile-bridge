import { describe, it, expect } from "bun:test";
import { parseCron, matchesAt } from "../cron/parser";

function utc(yy: number, mm: number, dd: number, h: number, m: number): Date {
  return new Date(Date.UTC(yy, mm - 1, dd, h, m, 0, 0));
}

describe("parseCron", () => {
  it("all-wildcards matches every minute", () => {
    const e = parseCron("* * * * *");
    expect(matchesAt(e, utc(2026, 5, 31, 0, 0))).toBe(true);
    expect(matchesAt(e, utc(2026, 12, 25, 23, 59))).toBe(true);
  });

  it("literal minute matches only that minute", () => {
    const e = parseCron("15 * * * *");
    expect(matchesAt(e, utc(2026, 5, 31, 12, 15))).toBe(true);
    expect(matchesAt(e, utc(2026, 5, 31, 12, 16))).toBe(false);
  });

  it("daily-at-09:00 UTC", () => {
    const e = parseCron("0 9 * * *");
    expect(matchesAt(e, utc(2026, 5, 31, 9, 0))).toBe(true);
    expect(matchesAt(e, utc(2026, 5, 31, 9, 1))).toBe(false);
    expect(matchesAt(e, utc(2026, 5, 31, 8, 0))).toBe(false);
  });

  it("step every 5 minutes", () => {
    const e = parseCron("*/5 * * * *");
    expect(matchesAt(e, utc(2026, 5, 31, 12, 0))).toBe(true);
    expect(matchesAt(e, utc(2026, 5, 31, 12, 5))).toBe(true);
    expect(matchesAt(e, utc(2026, 5, 31, 12, 7))).toBe(false);
  });

  it("range hours", () => {
    const e = parseCron("0 9-17 * * *");
    expect(matchesAt(e, utc(2026, 5, 31, 9, 0))).toBe(true);
    expect(matchesAt(e, utc(2026, 5, 31, 17, 0))).toBe(true);
    expect(matchesAt(e, utc(2026, 5, 31, 18, 0))).toBe(false);
  });

  it("comma list", () => {
    const e = parseCron("0,30 * * * *");
    expect(matchesAt(e, utc(2026, 5, 31, 5, 0))).toBe(true);
    expect(matchesAt(e, utc(2026, 5, 31, 5, 30))).toBe(true);
    expect(matchesAt(e, utc(2026, 5, 31, 5, 15))).toBe(false);
  });

  it("dow Monday only (1)", () => {
    const e = parseCron("0 12 * * 1");
    // 2026-06-01 is a Monday
    expect(matchesAt(e, utc(2026, 6, 1, 12, 0))).toBe(true);
    // 2026-06-02 is Tuesday
    expect(matchesAt(e, utc(2026, 6, 2, 12, 0))).toBe(false);
  });

  it("dow 7 is normalised to Sunday (0)", () => {
    const e = parseCron("0 12 * * 7");
    // 2026-05-31 is a Sunday
    expect(matchesAt(e, utc(2026, 5, 31, 12, 0))).toBe(true);
  });

  it("rejects wrong field count", () => {
    expect(() => parseCron("* * *")).toThrow();
    expect(() => parseCron("* * * * * *")).toThrow();
  });

  it("rejects out-of-range values", () => {
    expect(() => parseCron("60 * * * *")).toThrow();
    expect(() => parseCron("* 24 * * *")).toThrow();
    expect(() => parseCron("* * 0 * *")).toThrow();
    expect(() => parseCron("* * * 13 *")).toThrow();
    expect(() => parseCron("* * * * 8")).toThrow();
  });

  it("step with explicit start", () => {
    const e = parseCron("3/15 * * * *");
    expect(matchesAt(e, utc(2026, 5, 31, 12, 3))).toBe(true);
    expect(matchesAt(e, utc(2026, 5, 31, 12, 18))).toBe(true);
    expect(matchesAt(e, utc(2026, 5, 31, 12, 33))).toBe(true);
    expect(matchesAt(e, utc(2026, 5, 31, 12, 4))).toBe(false);
  });

  it("POSIX DOM/DOW OR: both restricted → matches on either", () => {
    // 0 9 1 * 1 = 09:00 UTC on the 1st of month OR Monday
    const e = parseCron("0 9 1 * 1");
    // 2026-06-01 is a Monday (both dom=1 and dow=1) → should match
    expect(matchesAt(e, utc(2026, 6, 1, 9, 0))).toBe(true);
    // 2026-07-01 is a Wednesday (dom=1, dow=3) → should match via dom
    expect(matchesAt(e, utc(2026, 7, 1, 9, 0))).toBe(true);
    // 2026-06-08 is a Monday (dom=8, dow=1) → should match via dow
    expect(matchesAt(e, utc(2026, 6, 8, 9, 0))).toBe(true);
    // 2026-06-09 is a Tuesday, not the 1st → should NOT match
    expect(matchesAt(e, utc(2026, 6, 9, 9, 0))).toBe(false);
    // Wrong hour → should NOT match
    expect(matchesAt(e, utc(2026, 6, 1, 10, 0))).toBe(false);
  });

  it("DOM/DOW: both unrestricted (dom=* dow=*) → matches any day", () => {
    const e = parseCron("0 9 * * *");
    expect(matchesAt(e, utc(2026, 6, 1, 9, 0))).toBe(true);
    expect(matchesAt(e, utc(2026, 6, 9, 9, 0))).toBe(true);
    expect(matchesAt(e, utc(2026, 7, 15, 9, 0))).toBe(true);
  });

  it("DOM/DOW: only dom restricted (dow=*) → AND filters by dom", () => {
    // Only the 15th of any month
    const e = parseCron("0 9 15 * *");
    expect(matchesAt(e, utc(2026, 6, 15, 9, 0))).toBe(true);
    expect(matchesAt(e, utc(2026, 6, 14, 9, 0))).toBe(false);
    // 2026-06-15 is a Monday, but dow=* so any day-of-week is fine
  });

  it("DOM/DOW: only dow restricted (dom=*) → AND filters by dow", () => {
    // Every Monday
    const e = parseCron("0 9 * * 1");
    // 2026-06-01, 06-08, 06-15 are Mondays
    expect(matchesAt(e, utc(2026, 6, 1, 9, 0))).toBe(true);
    expect(matchesAt(e, utc(2026, 6, 8, 9, 0))).toBe(true);
    expect(matchesAt(e, utc(2026, 6, 2, 9, 0))).toBe(false);
  });

  it("rejects reversed range", () => {
    expect(() => parseCron("5-2 * * * *")).toThrow(/reversed range/);
    expect(() => parseCron("* 23-5 * * *")).toThrow(/reversed range/);
    expect(() => parseCron("* * 31-1 * *")).toThrow(/reversed range/);
  });

  it("rejects field expanding to empty set", () => {
    // step that starts beyond the range and never enters the loop
    // e.g. minute=60/5 starts at 60, hi=59 → empty
    expect(() => parseCron("60/5 * * * *")).toThrow(/empty set/);
  });
});
