import { describe, test, expect } from "bun:test";
import { reportIdentityViolations } from "../sessions/identity-report";
import type { PortFileData } from "../relay/discovery";
import type { SessionInfo } from "../sessions/types";
import type { TopicMapping } from "../topics/topic-store";

const relay = (o: Partial<PortFileData>): PortFileData =>
  ({
    port: 1,
    pid: process.pid,
    ppid: 9,
    cwd: "/p",
    startedAt: "2026-01-01T00:00:00Z",
    ...o,
  }) as PortFileData;

const sess = (o: Partial<SessionInfo>): SessionInfo => ({
  id: "",
  name: "s",
  dir: "/p",
  lastActivity: 0,
  source: "desktop",
  ...o,
});

const topic = (o: Partial<TopicMapping>): TopicMapping => ({
  topicId: 1,
  sessionName: "s",
  sessionId: "",
  sessionDir: "/p",
  isOnline: true,
  createdAt: "2026-01-01T00:00:00Z",
  ...o,
});

describe("reportIdentityViolations", () => {
  test("logs a warn line for a missing-sessionId live relay", () => {
    const warns: Array<[string, unknown]> = [];
    const spy = (msg: string, ctx?: unknown) => warns.push([msg, ctx]);

    const out = reportIdentityViolations(
      {
        sessions: [],
        topics: [],
        // pid=process.pid so isProcessAlive() passes
        portFiles: [relay({ cwd: "/solo", sessionId: undefined })],
      },
      spy,
    );
    expect(out.map((v) => v.kind)).toContain("missing_session_id");
    expect(warns.some(([m]) => m.startsWith("identity:"))).toBe(true);
  });

  test("dead relays are filtered out before checking", () => {
    const warns: Array<[string, unknown]> = [];
    const spy = (msg: string, ctx?: unknown) => warns.push([msg, ctx]);

    const out = reportIdentityViolations(
      {
        sessions: [],
        topics: [],
        portFiles: [relay({ pid: 999999, cwd: "/solo", sessionId: undefined })],
      },
      spy,
    );
    expect(out).toEqual([]);
    expect(warns.length).toBe(0);
  });

  test("registry projection: authoritative desktop session whose relay claudePid (ppid) disagrees with the watcher's SessionInfo.pid is flagged", () => {
    const warns: Array<[string, unknown]> = [];
    const spy = (msg: string, ctx?: unknown) => warns.push([msg, ctx]);

    const out = reportIdentityViolations(
      {
        sessions: [sess({ name: "a", id: "sX", pid: 100 })],
        topics: [topic({ topicId: 9, sessionName: "a", sessionId: "sX" })],
        // relay's ppid (999) disagrees with the SessionInfo.pid (100) the
        // registry projection pushes for this authoritative desktop session.
        portFiles: [
          relay({ pid: process.pid, ppid: 999, sessionId: "sX", cwd: "/p" }),
        ],
      },
      spy,
    );

    expect(out.map((v) => v.kind)).toContain("resolveSession_topic_disagree");
    const v = out.find((v) => v.kind === "resolveSession_topic_disagree");
    expect(v?.sessionId).toBe("sX");
    expect(v?.detail).toContain("claudePid");
    expect(
      warns.some(
        ([m, ctx]) =>
          m === "identity: resolveSession_topic_disagree" &&
          (ctx as any)?.sessionId === "sX",
      ),
    ).toBe(true);
  });

  test("registry projection: aligned authoritative desktop session yields no resolveSession disagreement", () => {
    const warns: Array<[string, unknown]> = [];
    const spy = (msg: string, ctx?: unknown) => warns.push([msg, ctx]);

    const out = reportIdentityViolations(
      {
        sessions: [sess({ name: "a", id: "sX", pid: 999 })],
        topics: [topic({ topicId: 9, sessionName: "a", sessionId: "sX" })],
        portFiles: [
          relay({ pid: process.pid, ppid: 999, sessionId: "sX", cwd: "/p" }),
        ],
      },
      spy,
    );

    expect(out.map((v) => v.kind)).not.toContain(
      "resolveSession_topic_disagree",
    );
    expect(
      warns.some(([m]) => m === "identity: resolveSession_topic_disagree"),
    ).toBe(false);
  });
});
