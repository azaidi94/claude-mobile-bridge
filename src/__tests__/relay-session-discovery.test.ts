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
});
