import { test, expect } from "bun:test";
import { makeRecord, type SessionRecord } from "./resolve-session";

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
