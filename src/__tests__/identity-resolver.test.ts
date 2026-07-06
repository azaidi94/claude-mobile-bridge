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

  test("an id-less relay sharing a cwd with ANY other relay is 'ambiguous' (broad rule, coherent with WS-1 + the watcher)", () => {
    const out = resolveIdentities({
      aliveRelays: [
        relay({ pid: 1, ppid: 11, cwd: "/mix", sessionId: "sid-1" }),
        relay({ pid: 2, ppid: 22, cwd: "/mix", sessionId: undefined }),
      ],
      topics: [],
    });
    expect(out.find((r) => r.relayPid === 2)!.provenance).toBe("ambiguous");
  });
});

describe("resolveIdentities — adversarial (WS-4)", () => {
  test("empty input yields empty output", () => {
    expect(resolveIdentities({ aliveRelays: [], topics: [] })).toEqual([]);
  });

  test("three id-less relays in one cwd are all ambiguous", () => {
    const out = resolveIdentities({
      aliveRelays: [
        relay({ pid: 1, ppid: 11, cwd: "/d" }),
        relay({ pid: 2, ppid: 22, cwd: "/d" }),
        relay({ pid: 3, ppid: 33, cwd: "/d" }),
      ],
      topics: [],
    });
    expect(out.map((r) => r.provenance)).toEqual([
      "ambiguous",
      "ambiguous",
      "ambiguous",
    ]);
  });

  test("three siblings: one authoritative, two id-less → the two are ambiguous (broad rule)", () => {
    const out = resolveIdentities({
      aliveRelays: [
        relay({ pid: 1, ppid: 11, cwd: "/d", sessionId: "sid-1" }),
        relay({ pid: 2, ppid: 22, cwd: "/d" }),
        relay({ pid: 3, ppid: 33, cwd: "/d" }),
      ],
      topics: [topic({ topicId: 9, sessionId: "sid-1" })],
    });
    expect(out.find((r) => r.relayPid === 1)!.provenance).toBe("authoritative");
    expect(out.find((r) => r.relayPid === 1)!.topicId).toBe(9);
    expect(out.find((r) => r.relayPid === 2)!.provenance).toBe("ambiguous");
    expect(out.find((r) => r.relayPid === 3)!.provenance).toBe("ambiguous");
  });

  test("ambiguity is per-cwd: a lone relay in another dir stays missing", () => {
    const out = resolveIdentities({
      aliveRelays: [
        relay({ pid: 1, ppid: 11, cwd: "/shared" }),
        relay({ pid: 2, ppid: 22, cwd: "/shared" }),
        relay({ pid: 3, ppid: 33, cwd: "/solo" }),
      ],
      topics: [],
    });
    expect(out.find((r) => r.relayPid === 3)!.provenance).toBe("missing");
    expect(out.find((r) => r.relayPid === 1)!.provenance).toBe("ambiguous");
  });

  test("cwd with spaces/dots/unicode is grouped verbatim (resolver does not encode paths)", () => {
    const weird = "/Users/a/My Project (v2)/café_dir";
    const out = resolveIdentities({
      aliveRelays: [
        relay({ pid: 1, ppid: 11, cwd: weird, sessionId: "sid-w" }),
        relay({ pid: 2, ppid: 22, cwd: weird }),
      ],
      topics: [],
    });
    // Both share the exact cwd → the id-less one is ambiguous.
    expect(out.find((r) => r.relayPid === 2)!.provenance).toBe("ambiguous");
    expect(out.find((r) => r.relayPid === 1)!.cwd).toBe(weird);
  });

  test("an authoritative sessionId with no matching topic resolves topicId null", () => {
    const out = resolveIdentities({
      aliveRelays: [relay({ sessionId: "orphan-sid" })],
      topics: [topic({ sessionId: "different-sid", topicId: 5 })],
    });
    expect(out[0]!.provenance).toBe("authoritative");
    expect(out[0]!.topicId).toBeNull();
  });
});
