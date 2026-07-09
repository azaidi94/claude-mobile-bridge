import { test, expect, describe, beforeEach } from "bun:test";
import {
  planTopicDeletions,
  reapDeadTopics,
  _resetReaperState,
  type ReaperState,
} from "../sessions/topic-reaper";
import type { RegistryRecord } from "../sessions/registry";

const rec = (
  launchUuid: string,
  claudePid: number,
  source = "test",
): RegistryRecord => ({
  launchUuid,
  claudePid,
  startTime: "x",
  sessionId: "s",
  cwd: "/c",
  source,
  updatedAt: "2026-07-07T00:00:00Z",
});

const st = (
  deaths: [string, number][] = [],
  seenAlive: string[] = [],
): ReaperState => ({
  deaths: new Map(deaths),
  seenAlive: new Set(seenAlive),
});

const opts = { threshold: 2, inGrace: false };

describe("planTopicDeletions", () => {
  test("a live pid is marked seen-alive and its death count resets; never deletes", () => {
    const out = planTopicDeletions(
      [rec("u1", 100)],
      new Set([100]),
      st([["u1", 1]]),
      opts,
    );
    expect(out.toDelete).toEqual([]);
    expect(out.seenAlive.has("u1")).toBe(true);
    expect(out.deaths.get("u1") ?? 0).toBe(0);
  });

  test("Guard 1: a historical session NEVER seen alive this run is never reaped", () => {
    // u1 is dead and has a topic, but was never observed live this run (not in
    // seenAlive). Another session (u2/200) IS live, so the scan is trustworthy.
    const out = planTopicDeletions(
      [rec("u1", 100), rec("u2", 200)],
      new Set([200]), // only u2 live; u1 never seen
      st(),
      opts,
    );
    expect(out.toDelete).toEqual([]);
    const out2 = planTopicDeletions(
      [rec("u1", 100), rec("u2", 200)],
      new Set([200]),
      { deaths: out.deaths, seenAlive: out.seenAlive },
      opts,
    );
    expect(out2.toDelete).toEqual([]); // still never — historical, untracked
  });

  test("reaps a seen-alive session after threshold consecutive dead ticks (with another live session)", () => {
    const records = [rec("u1", 100), rec("u2", 200)];
    // tick 1: both live → both seen
    let s: ReaperState = st();
    let out = planTopicDeletions(records, new Set([100, 200]), s, opts);
    expect(out.seenAlive.has("u1")).toBe(true);
    s = { deaths: out.deaths, seenAlive: out.seenAlive };
    // tick 2: u1 dead, u2 live → miss 1, not deleted
    out = planTopicDeletions(records, new Set([200]), s, opts);
    expect(out.toDelete).toEqual([]);
    expect(out.deaths.get("u1")).toBe(1);
    s = { deaths: out.deaths, seenAlive: out.seenAlive };
    // tick 3: u1 still dead, u2 live → miss 2 → delete
    out = planTopicDeletions(records, new Set([200]), s, opts);
    expect(out.toDelete).toEqual(["u1"]);
    expect(out.seenAlive.has("u1")).toBe(false);
  });

  test("Guard 2: an empty live-pid set (failed/degenerate scan) reaps NOTHING, even a seen-alive dead session", () => {
    const out = planTopicDeletions(
      [rec("u1", 100)],
      new Set(), // scan returned nothing — untrustworthy
      st([["u1", 1]], ["u1"]), // u1 was seen alive + already 1 miss
      opts,
    );
    expect(out.toDelete).toEqual([]);
  });

  test("Guard 3: grace window freezes deletion during startup", () => {
    const out = planTopicDeletions(
      [rec("u1", 100), rec("u2", 200)],
      new Set([200]),
      st([["u1", 1]], ["u1"]),
      { threshold: 2, inGrace: true },
    );
    expect(out.toDelete).toEqual([]);
  });

  test("a single missed tick then recovery never deletes", () => {
    const records = [rec("u1", 100), rec("u2", 200)];
    let out = planTopicDeletions(records, new Set([100, 200]), st(), opts); // both seen
    out = planTopicDeletions(records, new Set([200]), out, opts); // miss 1
    expect(out.deaths.get("u1")).toBe(1);
    const back = planTopicDeletions(records, new Set([100, 200]), out, opts); // u1 back
    expect(back.toDelete).toEqual([]);
    expect(back.deaths.get("u1")).toBe(0);
  });

  test("cursor-source sessions are never reaped (liveness unknown via ps/lsof)", () => {
    const records = [rec("u1", 100, "cursor"), rec("u2", 200)];
    let out = planTopicDeletions(records, new Set([100, 200]), st(), opts); // both seen
    out = planTopicDeletions(records, new Set([200]), out, opts);
    out = planTopicDeletions(records, new Set([200]), out, opts);
    expect(out.toDelete).toEqual([]); // u1 is cursor → skipped despite being seen+dead
  });

  test("/clear (pid unchanged) is safe — the live pid always resets", () => {
    const out = planTopicDeletions(
      [rec("u1", 100)],
      new Set([100]),
      st([["u1", 1]], ["u1"]),
      opts,
    );
    expect(out.toDelete).toEqual([]);
  });
});

describe("reapDeadTopics (gated IO wrapper)", () => {
  beforeEach(() => {
    _resetReaperState();
    delete process.env.CLAUDE_TOPIC_REAPER;
  });

  test("no-op when the reaper flag is off (default) — never calls deleteTopic", async () => {
    const deleted = await reapDeadTopics({
      records: [rec("u1", 100)],
      livePids: new Set(),
      inGrace: false,
      hasTopic: () => true,
      deleteTopic: async () => {
        throw new Error("deleteTopic must not be called while gated off");
      },
    });
    expect(deleted).toEqual([]);
  });

  test("when enabled, deletes a seen-alive ended session's topic after the threshold", async () => {
    process.env.CLAUDE_TOPIC_REAPER = "1";
    const calls: string[] = [];
    const base = {
      records: [rec("u1", 100), rec("u2", 200)],
      inGrace: false,
      hasTopic: (u: string) => u === "u1",
      deleteTopic: async (u: string) => {
        calls.push(u);
      },
    };
    // tick 1: both live → tracked, nothing deleted
    expect(
      await reapDeadTopics({ ...base, livePids: new Set([100, 200]) }),
    ).toEqual([]);
    // tick 2: u1 dead, u2 live → miss 1
    expect(await reapDeadTopics({ ...base, livePids: new Set([200]) })).toEqual(
      [],
    );
    // tick 3: u1 dead → threshold → delete
    expect(await reapDeadTopics({ ...base, livePids: new Set([200]) })).toEqual(
      ["u1"],
    );
    expect(calls).toEqual(["u1"]);
  });

  test("when enabled, never deletes a historical (never-seen-alive) session's topic", async () => {
    process.env.CLAUDE_TOPIC_REAPER = "1";
    const base = {
      records: [rec("u1", 100), rec("u2", 200)],
      inGrace: false,
      hasTopic: () => true,
      deleteTopic: async () => {
        throw new Error("must not delete a historical session's topic");
      },
    };
    // u1 dead from the start, only u2 live — u1 is never seen alive
    await reapDeadTopics({ ...base, livePids: new Set([200]) });
    expect(await reapDeadTopics({ ...base, livePids: new Set([200]) })).toEqual(
      [],
    );
  });
});
