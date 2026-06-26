import { describe, test, expect } from "bun:test";
import { resolveIdentities } from "../sessions/identity";
import type { PortFileData } from "../relay/discovery";
import type { TopicMapping } from "../topics/topic-store";

const relay = (o: Partial<PortFileData>): PortFileData =>
  ({
    port: 1,
    pid: 100,
    ppid: 99,
    cwd: "/p",
    startedAt: "2026-01-01T00:00:00Z",
    ...o,
  }) as PortFileData;
const topic = (o: Partial<TopicMapping>): TopicMapping => ({
  topicId: 1,
  sessionName: "s",
  sessionId: "",
  sessionDir: "/p",
  isOnline: true,
  createdAt: "2026-01-01T00:00:00Z",
  ...o,
});

describe("resolveIdentities", () => {
  test("a relay with a sessionId resolves as authoritative and links its topic", () => {
    const out = resolveIdentities({
      aliveRelays: [
        relay({ pid: 100, ppid: 99, cwd: "/p", sessionId: "sid-a" }),
      ],
      topics: [topic({ topicId: 7, sessionId: "sid-a" })],
    });
    expect(out).toEqual([
      {
        claudePid: 99,
        relayPid: 100,
        cwd: "/p",
        sessionId: "sid-a",
        provenance: "authoritative",
        topicId: 7,
      },
    ]);
  });

  test("a lone id-less relay is 'missing' with no topic", () => {
    const out = resolveIdentities({
      aliveRelays: [relay({ cwd: "/solo", sessionId: undefined })],
      topics: [],
    });
    expect(out[0]!.provenance).toBe("missing");
    expect(out[0]!.sessionId).toBeNull();
    expect(out[0]!.topicId).toBeNull();
  });

  test("two id-less relays in one cwd are both 'ambiguous'", () => {
    const out = resolveIdentities({
      aliveRelays: [
        relay({ pid: 1, ppid: 11, cwd: "/shared", sessionId: undefined }),
        relay({ pid: 2, ppid: 22, cwd: "/shared", sessionId: undefined }),
      ],
      topics: [],
    });
    expect(out.map((r) => r.provenance)).toEqual(["ambiguous", "ambiguous"]);
  });

  test("authoritative siblings in one cwd each link their own topic by sessionId", () => {
    const out = resolveIdentities({
      aliveRelays: [
        relay({ pid: 1, ppid: 11, cwd: "/shared", sessionId: "sid-1" }),
        relay({ pid: 2, ppid: 22, cwd: "/shared", sessionId: "sid-2" }),
      ],
      topics: [
        topic({ topicId: 1, sessionId: "sid-1" }),
        topic({ topicId: 2, sessionId: "sid-2" }),
      ],
    });
    expect(out.find((r) => r.relayPid === 1)!.topicId).toBe(1);
    expect(out.find((r) => r.relayPid === 2)!.topicId).toBe(2);
  });

  test("an id-less relay sharing a cwd with an authoritative one is still 'missing' (only id-less siblings make it ambiguous)", () => {
    const out = resolveIdentities({
      aliveRelays: [
        relay({ pid: 1, ppid: 11, cwd: "/mix", sessionId: "sid-1" }),
        relay({ pid: 2, ppid: 22, cwd: "/mix", sessionId: undefined }),
      ],
      topics: [],
    });
    expect(out.find((r) => r.relayPid === 2)!.provenance).toBe("missing");
  });
});
