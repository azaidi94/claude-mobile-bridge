/**
 * Unit tests for the relay's post-/clear session re-discovery selection.
 *
 * Regression context: the relay used to re-select the launch file after a
 * /clear (birthtime-closeness anchored to relay start), so the port file's
 * sessionId never advanced and the bot's watch — which follows it for shared
 * dirs — stayed frozen on the dead transcript.
 */

import { describe, expect, test } from "bun:test";
import {
  pickRolledSessionId,
  pickSessionIdForPid,
  RECENCY_ADVANTAGE_MS,
  type JsonlCandidate,
} from "../mcp/channel-relay/session-discovery";
import type { RegistryRecord } from "../sessions/registry";

const SERVER_START = 1_000;
const current: JsonlCandidate = {
  id: "launch",
  birthtimeMs: 1_000, // born at relay start — the "birthtime-closest" candidate
  mtimeMs: 2_000,
};

describe("pickRolledSessionId", () => {
  test("adopts the newer transcript after a /clear (not the launch file)", () => {
    const candidates: JsonlCandidate[] = [
      current,
      { id: "after-clear", birthtimeMs: 3_000, mtimeMs: 4_000 },
    ];
    const result = pickRolledSessionId(
      candidates,
      current,
      new Set(),
      SERVER_START,
    );
    expect(result).toBe("after-clear");
    expect(result).not.toBe("launch"); // the exact regression
  });

  test("returns undefined when nothing is newer — caller keeps current", () => {
    const candidates: JsonlCandidate[] = [
      current,
      { id: "older", birthtimeMs: 500, mtimeMs: 1_500 },
    ];
    expect(
      pickRolledSessionId(candidates, current, new Set(), SERVER_START),
    ).toBeUndefined();
  });

  test("skips ids claimed by sibling relays, picks the next newest unclaimed", () => {
    const candidates: JsonlCandidate[] = [
      { id: "sibling-newest", birthtimeMs: 3_000, mtimeMs: 5_000 },
      { id: "mine", birthtimeMs: 3_000, mtimeMs: 4_000 },
    ];
    const result = pickRolledSessionId(
      candidates,
      current,
      new Set(["sibling-newest"]),
      SERVER_START,
    );
    expect(result).toBe("mine");
  });

  test("picks the newest by mtime among several newer candidates", () => {
    const candidates: JsonlCandidate[] = [
      { id: "x", birthtimeMs: 3_000, mtimeMs: 4_000 },
      { id: "y", birthtimeMs: 3_000, mtimeMs: 9_000 },
      { id: "z", birthtimeMs: 3_000, mtimeMs: 5_000 },
    ];
    expect(
      pickRolledSessionId(candidates, current, new Set(), SERVER_START),
    ).toBe("y");
  });

  test("recency-advantage: adopts an older-born transcript modified far more recently (resume)", () => {
    const cur: JsonlCandidate = {
      id: "cur",
      birthtimeMs: 5_000,
      mtimeMs: 5_000,
    };
    const candidates: JsonlCandidate[] = [
      cur,
      {
        id: "resumed",
        birthtimeMs: 1_000, // born BEFORE current
        mtimeMs: 5_000 + RECENCY_ADVANTAGE_MS + 1, // but touched far more recently
      },
    ];
    expect(pickRolledSessionId(candidates, cur, new Set(), 0)).toBe("resumed");
  });

  test("never returns the current id itself", () => {
    expect(
      pickRolledSessionId([current], current, new Set(), SERVER_START),
    ).toBeUndefined();
  });

  test("never oscillates: contradictory birth/mtime orderings settle on the newest-mtime transcript", () => {
    // Regression: A born before relay start but last-active recently, B born
    // after relay start but idle for hours. The birthtime branch said B is
    // newer than A while the recency branch said A is newer than B, so the
    // 15s loop flipped the port file A→B→A forever — and the bot's watch
    // spammed "🔄 new conversation" into the topic on every flip.
    const serverStart = 10_000_000;
    const a: JsonlCandidate = {
      id: "a",
      birthtimeMs: 5_000_000, // born before relay start
      mtimeMs: 60_000_000, // most recent activity
    };
    const b: JsonlCandidate = {
      id: "b",
      birthtimeMs: 20_000_000, // born after relay start
      mtimeMs: 30_000_000, // idle since long before a's last write
    };
    // Holding a: b's last activity is OLDER — no roll backward.
    expect(
      pickRolledSessionId([a, b], a, new Set(), serverStart),
    ).toBeUndefined();
    // Holding b: a was modified far more recently — one forward roll, stable.
    expect(pickRolledSessionId([a, b], b, new Set(), serverStart)).toBe("a");
  });
});

describe("pickSessionIdForPid", () => {
  const rec = (o: Partial<RegistryRecord>): RegistryRecord => ({
    launchUuid: "u",
    claudePid: 1,
    startTime: "T",
    sessionId: "s",
    cwd: "/c",
    source: "startup",
    updatedAt: "2026-01-01T00:00:00Z",
    ...o,
  });

  test("returns the authoritative sessionId for the relay's own parent (pid, startTime)", () => {
    const records = [
      rec({ claudePid: 100, startTime: "SA", sessionId: "sid-A" }),
      rec({ claudePid: 200, startTime: "SB", sessionId: "sid-B" }),
    ];
    expect(pickSessionIdForPid(records, 200, "SB")).toBe("sid-B");
  });

  test("never attributes a sibling's transcript — two sessions in one cwd stay distinct", () => {
    // The exact corruption vector: the JSONL heuristic could hand pid-200's
    // relay sid-A. Keyed on the real launch identity, it cannot.
    const records = [
      rec({
        claudePid: 100,
        startTime: "SA",
        sessionId: "sid-A",
        cwd: "/shared",
      }),
      rec({
        claudePid: 200,
        startTime: "SB",
        sessionId: "sid-B",
        cwd: "/shared",
      }),
    ];
    expect(pickSessionIdForPid(records, 100, "SA")).toBe("sid-A");
    expect(pickSessionIdForPid(records, 200, "SB")).toBe("sid-B");
  });

  test("a reused pid does NOT serve a dead session's record — the startTime disambiguates", () => {
    // Registry records are never pruned; the OS later reuses pid 100 for a new
    // launch (startTime NEW). During the new session's pre-hook window only the
    // DEAD record (startTime OLD) exists — matching on pid alone would serve
    // sid-DEAD. Requiring the startTime match returns undefined → heuristic.
    const records = [
      rec({ claudePid: 100, startTime: "OLD", sessionId: "sid-DEAD" }),
    ];
    expect(pickSessionIdForPid(records, 100, "NEW")).toBeUndefined();
    expect(pickSessionIdForPid(records, 100, "OLD")).toBe("sid-DEAD");
  });

  test("on a duplicate write of the same launch, the latest updatedAt wins", () => {
    const records = [
      rec({
        claudePid: 100,
        startTime: "S",
        sessionId: "sid-OLD",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      rec({
        claudePid: 100,
        startTime: "S",
        sessionId: "sid-NEW",
        updatedAt: "2026-06-01T00:00:00Z",
      }),
    ];
    expect(pickSessionIdForPid(records, 100, "S")).toBe("sid-NEW");
  });

  test("returns undefined when no record matches or startTime is unknown (→ heuristic fallback)", () => {
    const records = [rec({ claudePid: 100, startTime: "S", sessionId: "sid" })];
    expect(pickSessionIdForPid(records, 999, "S")).toBeUndefined(); // pid miss
    expect(pickSessionIdForPid(records, 100, "")).toBeUndefined(); // ps failed
    expect(
      pickSessionIdForPid(
        [rec({ claudePid: 100, startTime: "S", sessionId: "" })],
        100,
        "S",
      ),
    ).toBeUndefined(); // record has no sessionId yet
  });
});
