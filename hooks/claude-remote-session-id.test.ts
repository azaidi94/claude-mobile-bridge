import { describe, test, expect } from "bun:test";
import { deriveClaudePid } from "./claude-remote-session-id";

test("deriveClaudePid prefers the port file's ppid when it's an ancestor", () => {
  const ancestry = [200, 300, 1]; // parent, grandparent, init
  const comm = (_p: number) => "bun";
  expect(deriveClaudePid(ancestry, comm, 300)).toBe(300);
});

test("deriveClaudePid falls back to the closest 'claude'-named ancestor", () => {
  const ancestry = [200, 300, 400];
  const comm = (p: number) => (p === 300 ? "claude" : "bash");
  expect(deriveClaudePid(ancestry, comm, undefined)).toBe(300);
});

test("deriveClaudePid ignores a portFilePpid that isn't in the ancestry", () => {
  const ancestry = [200, 300];
  const comm = (p: number) => (p === 200 ? "claude" : "bash");
  expect(deriveClaudePid(ancestry, comm, 999)).toBe(200);
});

test("deriveClaudePid returns undefined when nothing matches", () => {
  expect(deriveClaudePid([200, 300], () => "bash", undefined)).toBeUndefined();
});

// Task 2: mintDecision + registry IO

import { mintDecision, type RegistryRecord } from "./claude-remote-session-id";

const base = (o: Partial<RegistryRecord>): RegistryRecord => ({
  launchUuid: "u1",
  claudePid: 100,
  startTime: "T",
  sessionId: "s1",
  cwd: "/a",
  source: "startup",
  updatedAt: "t0",
  ...o,
});

test("mintDecision mints a NEW record when no pid+startTime match", () => {
  const d = mintDecision([], 100, "T", "s1", "/a", "startup", "t1", "NEW-UUID");
  expect(d.isNew).toBe(true);
  expect(d.record.launchUuid).toBe("NEW-UUID");
  expect(d.record.sessionId).toBe("s1");
});

test("mintDecision REUSES the launchUuid and re-anchors sessionId on a later fire", () => {
  const existing = [
    base({ launchUuid: "u1", claudePid: 100, startTime: "T", sessionId: "s1" }),
  ];
  const d = mintDecision(
    existing,
    100,
    "T",
    "s2-rolled",
    "/a",
    "clear",
    "t2",
    "IGNORED-UUID",
  );
  expect(d.isNew).toBe(false);
  expect(d.record.launchUuid).toBe("u1"); // stable
  expect(d.record.sessionId).toBe("s2-rolled"); // re-anchored
  expect(d.record.updatedAt).toBe("t2");
});

test("mintDecision treats same pid but different startTime as a NEW session (pid reuse)", () => {
  const existing = [base({ claudePid: 100, startTime: "T-old" })];
  const d = mintDecision(
    existing,
    100,
    "T-new",
    "s9",
    "/a",
    "startup",
    "t3",
    "NEW2",
  );
  expect(d.isNew).toBe(true);
  expect(d.record.launchUuid).toBe("NEW2");
});
