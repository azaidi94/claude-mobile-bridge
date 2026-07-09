import { test, expect, mock } from "bun:test";
import {
  shadowResolveSession,
  shadowTopicByLaunchUuid,
  __setShadowLogger,
} from "./identity-shadow";
import type { TopicMapping } from "../topics/topic-store";

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

// shadowTopicByLaunchUuid logs via the module's `info(...)` logger (stdout),
// not the `_shadowLog` seam — capture stdout writes the way other tests
// (e.g. safe-async.test.ts) capture logger output.
function captureStdout(): { lines: () => string; restore: () => void } {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // biome-ignore lint: test stub
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    lines: () => chunks.join(""),
    restore: () => {
      process.stdout.write = orig;
    },
  };
}

const relayFor = (pid: number, ppid: number, sessionId: string) => ({
  port: 1,
  pid,
  ppid,
  cwd: "/a",
  startedAt: "t",
  sessionId,
});

const topicMapping = (o: Partial<TopicMapping>): TopicMapping => ({
  topicId: 1,
  sessionName: "s",
  sessionDir: "/a",
  isOnline: true,
  createdAt: "t",
  ...o,
});

test("shadowTopicByLaunchUuid: logs a divergence when byLaunch topic differs from byToday topic", () => {
  const cap = captureStdout();
  try {
    shadowTopicByLaunchUuid({
      aliveRelays: [relayFor(20, 100, "sX") as any],
      topics: [
        topicMapping({ topicId: 5, sessionId: "sX" }), // byToday: pid 100 → topicId 5
        topicMapping({
          topicId: 7,
          sessionName: "other",
          launchUuid: "uuid-1",
        }), // byLaunch: topicId 7
      ],
      launchUuidByPid: new Map([[100, "uuid-1"]]),
    });
    expect(cap.lines()).toContain(
      "identity-shadow: topic launchUuid divergence",
    );
  } finally {
    cap.restore();
  }
});

test("shadowTopicByLaunchUuid: no log when byLaunch topic equals byToday topic", () => {
  const cap = captureStdout();
  try {
    shadowTopicByLaunchUuid({
      aliveRelays: [relayFor(20, 100, "sX") as any],
      topics: [
        topicMapping({ topicId: 5, sessionId: "sX", launchUuid: "uuid-1" }),
      ],
      launchUuidByPid: new Map([[100, "uuid-1"]]),
    });
    expect(cap.lines()).not.toContain(
      "identity-shadow: topic launchUuid divergence",
    );
  } finally {
    cap.restore();
  }
});

test("shadowTopicByLaunchUuid: no log when no topic carries the launchUuid yet (pending)", () => {
  const cap = captureStdout();
  try {
    shadowTopicByLaunchUuid({
      aliveRelays: [relayFor(20, 100, "sX") as any],
      topics: [topicMapping({ topicId: 5, sessionId: "sX" })],
      launchUuidByPid: new Map([[100, "uuid-1"]]),
    });
    expect(cap.lines()).not.toContain(
      "identity-shadow: topic launchUuid divergence",
    );
  } finally {
    cap.restore();
  }
});
