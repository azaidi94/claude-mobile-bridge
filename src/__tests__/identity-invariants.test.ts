import { describe, test, expect } from "bun:test";
import { checkIdentityInvariants } from "../sessions/identity-invariants";
import type { SessionInfo } from "../sessions/types";
import type { TopicMapping } from "../topics/topic-store";
import type { PortFileData } from "../relay/discovery";

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
const relay = (o: Partial<PortFileData>): PortFileData =>
  ({
    port: 1,
    pid: 10,
    ppid: 9,
    cwd: "/p",
    startedAt: "2026-01-01T00:00:00Z",
    ...o,
  }) as PortFileData;

describe("checkIdentityInvariants", () => {
  test("clean state yields no violations", () => {
    const out = checkIdentityInvariants({
      sessions: [sess({ name: "a", id: "id-a" })],
      topics: [topic({ sessionName: "a", sessionId: "id-a" })],
      aliveRelays: [relay({ sessionName: "a", sessionId: "id-a" })],
    });
    expect(out).toEqual([]);
  });

  test("flags two topics claiming the same sessionId", () => {
    const out = checkIdentityInvariants({
      sessions: [],
      topics: [
        topic({ topicId: 1, sessionName: "a", sessionId: "dup" }),
        topic({ topicId: 2, sessionName: "b", sessionId: "dup" }),
      ],
      aliveRelays: [],
    });
    expect(out.map((v) => v.kind)).toContain("duplicate_topic_for_session");
    expect(
      out.find((v) => v.kind === "duplicate_topic_for_session")?.sessionId,
    ).toBe("dup");
  });

  test("flags topic-store vs port-file sessionId disagreement for same name", () => {
    const out = checkIdentityInvariants({
      sessions: [],
      topics: [topic({ sessionName: "a", sessionId: "id-store" })],
      aliveRelays: [relay({ sessionName: "a", sessionId: "id-port" })],
    });
    expect(out.map((v) => v.kind)).toContain("store_disagreement");
  });

  test("flags a lone live relay with no sessionId as missing (recoverable)", () => {
    const out = checkIdentityInvariants({
      sessions: [],
      topics: [],
      aliveRelays: [relay({ cwd: "/solo", sessionId: undefined })],
    });
    expect(out.map((v) => v.kind)).toContain("missing_session_id");
  });

  test("flags id-less same-cwd siblings as ambiguous, not missing", () => {
    const out = checkIdentityInvariants({
      sessions: [],
      topics: [],
      aliveRelays: [
        relay({ pid: 1, cwd: "/shared", sessionId: undefined }),
        relay({ pid: 2, cwd: "/shared", sessionId: undefined }),
      ],
    });
    const kinds = out.map((v) => v.kind);
    expect(kinds).toContain("ambiguous_siblings");
    expect(kinds).not.toContain("missing_session_id");
  });

  test("registry id disagreeing with topic id for same name is flagged", () => {
    const out = checkIdentityInvariants({
      sessions: [sess({ name: "a", id: "id-reg" })],
      topics: [topic({ sessionName: "a", sessionId: "id-top" })],
      aliveRelays: [],
    });
    expect(out.map((v) => v.kind)).toContain("store_disagreement");
  });
});
