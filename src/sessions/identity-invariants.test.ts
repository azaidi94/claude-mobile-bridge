import { describe, test, expect } from "bun:test";
import { checkResolveSessionInvariant } from "./identity-invariants";
import type { ResolveSnapshot } from "./resolve-session";

const relay = (o: any) => ({
  port: 1,
  pid: 10,
  ppid: 100,
  cwd: "/a",
  startedAt: "t",
  ...o,
});

const topic = (o: any) => ({
  isOnline: true,
  createdAt: "2026-01-01T00:00:00Z",
  sessionDir: "/a",
  ...o,
});

describe("checkResolveSessionInvariant", () => {
  test("flags a session whose resolveSession topicId disagrees with the registry", () => {
    const snapshot: ResolveSnapshot = {
      aliveRelays: [relay({ sessionId: "sX" })],
      topics: [topic({ topicId: 9, sessionId: "sX", sessionName: "a" })],
    };
    const violations = checkResolveSessionInvariant({
      registry: [{ id: "sX", claudePid: 100, topicId: 7 }],
      snapshot,
    });
    expect(violations.map((v) => v.kind)).toContain(
      "resolveSession_topic_disagree",
    );
    const v = violations.find(
      (v) => v.kind === "resolveSession_topic_disagree",
    );
    expect(v?.sessionId).toBe("sX");
    expect(v?.detail).toContain("topicId");
  });

  test("flags a session whose resolveSession claudePid disagrees with the registry", () => {
    const snapshot: ResolveSnapshot = {
      aliveRelays: [relay({ sessionId: "sX", ppid: 100 })],
      topics: [topic({ topicId: 9, sessionId: "sX", sessionName: "a" })],
    };
    const violations = checkResolveSessionInvariant({
      registry: [{ id: "sX", claudePid: 999, topicId: 9 }],
      snapshot,
    });
    expect(violations.map((v) => v.kind)).toContain(
      "resolveSession_topic_disagree",
    );
    const v = violations.find(
      (v) => v.kind === "resolveSession_topic_disagree",
    );
    expect(v?.detail).toContain("claudePid");
  });

  test("flags a registry entry that resolveSession cannot resolve at all", () => {
    const snapshot: ResolveSnapshot = {
      aliveRelays: [],
      topics: [],
    };
    const violations = checkResolveSessionInvariant({
      registry: [{ id: "sGone", claudePid: 100, topicId: 9 }],
      snapshot,
    });
    expect(violations.map((v) => v.kind)).toContain(
      "resolveSession_topic_disagree",
    );
  });

  test("an aligned session yields no violation", () => {
    const snapshot: ResolveSnapshot = {
      aliveRelays: [relay({ sessionId: "sX", ppid: 100 })],
      topics: [topic({ topicId: 9, sessionId: "sX", sessionName: "a" })],
    };
    const violations = checkResolveSessionInvariant({
      registry: [{ id: "sX", claudePid: 100, topicId: 9 }],
      snapshot,
    });
    expect(violations).toEqual([]);
  });

  test("registry entries with no sessionId are skipped (not authoritative)", () => {
    const snapshot: ResolveSnapshot = { aliveRelays: [], topics: [] };
    const violations = checkResolveSessionInvariant({
      registry: [{ id: "", claudePid: 100, topicId: null }],
      snapshot,
    });
    expect(violations).toEqual([]);
  });
});
