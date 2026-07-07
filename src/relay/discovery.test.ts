import { test, expect } from "bun:test";
import { setCurrentSnapshot } from "../sessions/resolve-session";
import { selectRelayTarget, type PortFileData } from "./discovery";

function pf(overrides: Partial<PortFileData>): PortFileData {
  return {
    port: 1,
    pid: 10,
    ppid: 100,
    cwd: "/a",
    startedAt: "t",
    ...overrides,
  } as PortFileData;
}

test("selectRelayTarget: sessionId hit routes through resolveSession and returns the matching relay", () => {
  const target = pf({ sessionId: "sX", pid: 10 });
  const other = pf({ sessionId: "sY", pid: 11, port: 2, cwd: "/b" });

  const chosen = selectRelayTarget([target, other], { sessionId: "sX" });

  expect(chosen).toBe(target);
});

test("selectRelayTarget: pid hit routes through resolveSession and returns the matching relay", () => {
  const target = pf({ ppid: 100, pid: 10 });
  const other = pf({ ppid: 200, pid: 11, port: 2, cwd: "/b" });

  const chosen = selectRelayTarget([target, other], { claudePid: 100 });

  expect(chosen).toBe(target);
});

test("selectRelayTarget: sessionId given but unresolvable (miss) refuses, fails closed to null", () => {
  const other = pf({ sessionId: "sOther", pid: 10 });

  const chosen = selectRelayTarget([other], { sessionId: "sMissing" });

  expect(chosen).toBeNull();
});

test("selectRelayTarget: sessionId miss falls through to claudePid match (ladder combo, preserved)", () => {
  // Selector carries both sessionId (unresolvable) and claudePid (resolvable).
  // The old ladder tries sessionId first, then falls through to claudePid
  // before giving up — a single Handle can't express this, so the migrated
  // path must fall through to the preserved _selectRelayTargetImpl ladder.
  const target = pf({ ppid: 100, pid: 10 });

  const chosen = selectRelayTarget([target], {
    sessionId: "sMissing",
    claudePid: 100,
  });

  expect(chosen).toBe(target);
});

test("selectRelayTarget: cwd single match returns that relay", () => {
  const target = pf({ cwd: "/only", pid: 10 });
  const other = pf({ cwd: "/elsewhere", pid: 11, port: 2 });

  const chosen = selectRelayTarget([target, other], { sessionDir: "/only" });

  expect(chosen).toBe(target);
});

test("selectRelayTarget: cwd ambiguous (2 same-cwd siblings) refuses, returns null", () => {
  const a = pf({ cwd: "/shared", pid: 10, port: 1 });
  const b = pf({ cwd: "/shared", pid: 11, port: 2 });

  const chosen = selectRelayTarget([a, b], { sessionDir: "/shared" });

  expect(chosen).toBeNull();
});

test("selectRelayTarget: empty selector returns alive[0] (preserved, no handle built)", () => {
  const first = pf({ pid: 10, port: 1 });
  const second = pf({ pid: 11, port: 2, cwd: "/b" });

  const chosen = selectRelayTarget([first, second], {});

  expect(chosen).toBe(first);
});

test("selectRelayTarget: empty alive + empty selector returns null", () => {
  const chosen = selectRelayTarget([], {});

  expect(chosen).toBeNull();
});

test("migrated selectRelayTarget refuses ambiguous siblings (unchanged) even when the global snapshot disagrees", () => {
  const a = { port: 1, pid: 10, ppid: 100, cwd: "/a", startedAt: "t" } as any;
  const b = { port: 2, pid: 11, ppid: 101, cwd: "/a", startedAt: "t" } as any;
  // Global snapshot is set to something unrelated — the migration must
  // resolve over the caller's own `alive` array, never this snapshot.
  setCurrentSnapshot({ aliveRelays: [], topics: [] });

  expect(selectRelayTarget([a, b], { sessionDir: "/a" })).toBeNull();
});

test("selectRelayTarget resolves over the caller's alive array, not the global snapshot", () => {
  const live = pf({ sessionId: "sA", ppid: 100, pid: 10 });
  // Stale/unrelated global snapshot — must have zero effect on the result.
  const shadowStale = pf({ sessionId: "sB", ppid: 100, pid: 99 });
  setCurrentSnapshot({ aliveRelays: [shadowStale], topics: [] });

  const chosen = selectRelayTarget([live], { claudePid: 100 });

  expect(chosen).toBe(live);
});
