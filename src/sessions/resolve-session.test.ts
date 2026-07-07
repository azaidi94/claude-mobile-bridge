import { test, expect } from "bun:test";
import { makeRecord, type SessionRecord } from "./resolve-session";
import { resolveSession, type ResolveSnapshot } from "./resolve-session";
import { setCurrentSnapshot, getCurrentSnapshot } from "./resolve-session";

test("makeRecord defaults launchId to null (P1: never populated)", () => {
  const r: SessionRecord = makeRecord({
    sessionId: "s1",
    claudePid: 100,
    cwd: "/a",
    relayPort: 5,
    relayPid: 6,
    topicId: 42,
    tmuxPane: "%1",
    tmuxSocket: "claude",
    cmuxWorkspaceId: null,
    provenance: "authoritative",
  });
  expect(r.launchId).toBeNull();
  expect(r.sessionId).toBe("s1");
  expect(r.topicId).toBe(42);
});

function snap(relays: any[], topics: any[] = []): ResolveSnapshot {
  return { aliveRelays: relays, topics };
}
const relay = (o: any) => ({
  port: 1,
  pid: 10,
  ppid: 100,
  cwd: "/a",
  startedAt: "t",
  ...o,
});

test("by sessionId → resolved authoritative", () => {
  const s = snap(
    [relay({ sessionId: "sX", tmuxPane: "%3", tmuxSocket: "claude" })],
    [{ topicId: 7, sessionId: "sX", sessionName: "a", sessionDir: "/a" }],
  );
  const r = resolveSession({ by: "sessionId", sessionId: "sX" }, s);
  expect(r.status).toBe("resolved");
  if (r.status === "resolved") {
    expect(r.record.topicId).toBe(7);
    expect(r.record.tmuxPane).toBe("%3");
    expect(r.record.provenance).toBe("authoritative");
  }
});

test("by sessionId, no such session → miss", () => {
  const r = resolveSession(
    { by: "sessionId", sessionId: "nope" },
    snap([relay({ sessionId: "sX" })]),
  );
  expect(r.status).toBe("miss");
});

test("by cwd with 2 id-less siblings → miss (never guess across siblings)", () => {
  const s = snap([
    relay({ pid: 10, sessionId: undefined }),
    relay({ pid: 11, sessionId: undefined }),
  ]);
  const r = resolveSession({ by: "cwd", cwd: "/a" }, s);
  expect(r.status).toBe("miss");
});

test("by cwd, lone id-less relay → resolved with sessionId null (routes by pid today)", () => {
  const r = resolveSession(
    { by: "cwd", cwd: "/a" },
    snap([relay({ pid: 10, sessionId: undefined })]),
  );
  expect(r.status).toBe("resolved");
  if (r.status === "resolved") expect(r.record.sessionId).toBeNull();
});

test("current snapshot round-trips", () => {
  const s = { aliveRelays: [], topics: [] };
  setCurrentSnapshot(s);
  expect(getCurrentSnapshot()).toBe(s);
});
