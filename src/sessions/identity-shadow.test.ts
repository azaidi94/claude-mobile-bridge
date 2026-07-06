import { test, expect, mock } from "bun:test";
import { shadowResolveSession, __setShadowLogger } from "./identity-shadow";

test("logs a divergence when resolveSession disagrees with current answer", () => {
  const logged: any[] = [];
  __setShadowLogger((e) => logged.push(e));
  const relay = {
    port: 1,
    pid: 10,
    ppid: 100,
    cwd: "/a",
    startedAt: "t",
    sessionId: "sX",
  };
  // current answer says "sOLD" but resolveSession(byPid 100) → "sX"
  shadowResolveSession(
    "selectRelayTarget",
    "sOLD",
    { by: "pid", pid: 100 },
    { aliveRelays: [relay as any], topics: [] },
  );
  expect(logged.length).toBe(1);
  expect(logged[0].site).toBe("selectRelayTarget");
  expect(logged[0].current).toBe("sOLD");
  expect(logged[0].shadow).toBe("sX");
});

test("no log when they agree", () => {
  const logged: any[] = [];
  __setShadowLogger((e) => logged.push(e));
  const relay = {
    port: 1,
    pid: 10,
    ppid: 100,
    cwd: "/a",
    startedAt: "t",
    sessionId: "sX",
  };
  shadowResolveSession(
    "selectRelayTarget",
    "sX",
    { by: "pid", pid: 100 },
    { aliveRelays: [relay as any], topics: [] },
  );
  expect(logged.length).toBe(0);
});
