import { describe, test, expect } from "bun:test";
import { shadowCompareIdentities } from "../sessions/identity-shadow";
import type { PortFileData } from "../relay/discovery";

const relay = (o: Partial<PortFileData>): PortFileData =>
  ({
    port: 1,
    pid: process.pid,
    ppid: 99,
    cwd: "/p",
    startedAt: "2026-01-01T00:00:00Z",
    ...o,
  }) as PortFileData;

describe("shadowCompareIdentities (bidirectional)", () => {
  test("agreement on an authoritative id → no divergence", () => {
    const logs: string[] = [];
    const res = shadowCompareIdentities(
      {
        portFiles: [relay({ ppid: 99, sessionId: "sid-x" })],
        topics: [],
        registrySessions: [{ claudePid: 99, sessionId: "sid-x" }],
      },
      (m) => logs.push(m),
    );
    expect(res.divergences).toBe(0);
    expect(logs.length).toBe(0);
  });

  test("registry and resolver hold different ids for one pid → registry_resolver_disagree", () => {
    const logs: string[] = [];
    const res = shadowCompareIdentities(
      {
        portFiles: [relay({ ppid: 99, sessionId: "sid-resolver" })],
        topics: [],
        registrySessions: [{ claudePid: 99, sessionId: "sid-registry" }],
      },
      (m) => logs.push(m),
    );
    expect(res.divergences).toBe(1);
    expect(logs.some((m) => m.includes("registry_resolver_disagree"))).toBe(
      true,
    );
  });

  test("registry has an id the resolver is not authoritative for → registry_only", () => {
    // Relay has NO sessionId (resolver classifies it 'missing'), but the registry
    // resolved one via its own fallback. This is the gap WS-3b exists to catch.
    const logs: string[] = [];
    const res = shadowCompareIdentities(
      {
        portFiles: [relay({ ppid: 99, sessionId: undefined })],
        topics: [],
        registrySessions: [{ claudePid: 99, sessionId: "sid-registry-only" }],
      },
      (m) => logs.push(m),
    );
    expect(res.divergences).toBe(1);
    expect(logs.some((m) => m.includes("registry_only"))).toBe(true);
  });

  test("resolver authoritative for a pid the registry has no id for → resolver_only", () => {
    const logs: string[] = [];
    const res = shadowCompareIdentities(
      {
        portFiles: [relay({ ppid: 99, sessionId: "sid-resolver" })],
        topics: [],
        registrySessions: [],
      },
      (m) => logs.push(m),
    );
    expect(res.divergences).toBe(1);
    expect(logs.some((m) => m.includes("resolver_only"))).toBe(true);
  });

  test("dead relays are excluded; a registry entry for a dead pid is not 'registry_only'", () => {
    const res = shadowCompareIdentities({
      portFiles: [relay({ pid: 999999, ppid: 99, sessionId: "sid" })],
      topics: [],
      registrySessions: [{ claudePid: 99, sessionId: "sid" }],
    });
    // The dead relay is filtered out, so the resolver yields nothing for pid 99.
    // A registry entry whose pid has no live relay is not the resolver's failure —
    // it must NOT be flagged registry_only. (See Step 3 note.)
    expect(res.divergences).toBe(0);
  });

  test("claudePid <= 0 is skipped on both sides", () => {
    const res = shadowCompareIdentities({
      portFiles: [relay({ ppid: undefined, sessionId: "sid" })],
      topics: [],
      registrySessions: [{ claudePid: 0, sessionId: "sid" }],
    });
    expect(res.compared).toBe(0);
    expect(res.divergences).toBe(0);
  });
});
