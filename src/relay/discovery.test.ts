import { test, expect } from "bun:test";
import { __setShadowLogger } from "../sessions/identity-shadow";
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

test("selectRelayTarget returns current answer unchanged and logs no divergence when snapshot agrees", () => {
  const logged: any[] = [];
  __setShadowLogger((e) => logged.push(e));
  const target = pf({ sessionId: "sX" });
  setCurrentSnapshot({ aliveRelays: [target], topics: [] });

  const chosen = selectRelayTarget([target], { sessionId: "sX" });

  expect(chosen?.sessionId).toBe("sX"); // behavior unchanged
  expect(logged.length).toBe(0); // agrees → no divergence
});

test("selectRelayTarget logs a divergence when the shadow snapshot disagrees, but still returns the live answer", () => {
  const logged: any[] = [];
  __setShadowLogger((e) => logged.push(e));

  // Live call site sees pf1 (sessionId sA) for claudePid 100.
  const live = pf({ sessionId: "sA", ppid: 100 });
  // But the shadow snapshot (as if stale/out of sync) has a DIFFERENT
  // sessionId for the same claudePid — this must NOT affect the return
  // value, only produce a shadow-log divergence.
  const shadowStale = pf({ sessionId: "sB", ppid: 100 });
  setCurrentSnapshot({ aliveRelays: [shadowStale], topics: [] });

  const chosen = selectRelayTarget([live], { claudePid: 100 });

  expect(chosen?.sessionId).toBe("sA"); // behavior unchanged — uses `alive`, not the snapshot
  expect(logged.length).toBe(1);
  expect(logged[0].site).toBe("selectRelayTarget");
  expect(logged[0].current).toBe("sA");
  expect(logged[0].shadow).toBe("sB");
});

test("selectRelayTarget with no matching selector fields still returns null and does not shadow (no handle)", () => {
  const logged: any[] = [];
  __setShadowLogger((e) => logged.push(e));
  setCurrentSnapshot({ aliveRelays: [], topics: [] });

  const chosen = selectRelayTarget([], {});

  expect(chosen).toBeNull();
  expect(logged.length).toBe(0);
});
