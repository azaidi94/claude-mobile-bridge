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
  RECENCY_ADVANTAGE_MS,
  type JsonlCandidate,
} from "../mcp/channel-relay/session-discovery";

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
