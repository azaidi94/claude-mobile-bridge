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

describe("shadowCompareIdentities", () => {
  test("logs a divergence when the registry id differs from the resolver's authoritative id", () => {
    const logs: Array<[string, unknown]> = [];
    const res = shadowCompareIdentities(
      {
        portFiles: [relay({ ppid: 99, sessionId: "sid-resolver" })],
        topics: [],
        registryIdFor: (pid) => (pid === 99 ? "sid-registry" : undefined),
      },
      (m, c) => logs.push([m, c]),
    );
    expect(res.compared).toBe(1);
    expect(res.divergences).toBe(1);
    expect(logs.some(([m]) => m.startsWith("identity-shadow:"))).toBe(true);
  });

  test("no divergence when registry agrees with the resolver", () => {
    const logs: Array<[string, unknown]> = [];
    const res = shadowCompareIdentities(
      {
        portFiles: [relay({ ppid: 99, sessionId: "sid-x" })],
        topics: [],
        registryIdFor: () => "sid-x",
      },
      (m) => logs.push([m, undefined]),
    );
    expect(res.divergences).toBe(0);
    expect(logs.length).toBe(0);
  });

  test("dead relays are excluded from the comparison", () => {
    const res = shadowCompareIdentities({
      portFiles: [relay({ pid: 999999, ppid: 99, sessionId: "sid" })],
      topics: [],
      registryIdFor: () => "other",
    });
    expect(res.compared).toBe(0);
    expect(res.divergences).toBe(0);
  });

  test("identities with claudePid <= 0 (ppid absent) are skipped", () => {
    const logs: Array<[string, unknown]> = [];
    const res = shadowCompareIdentities(
      {
        // ppid absent → claudePid will be 0 via (r.ppid ?? 0)
        portFiles: [
          relay({
            pid: process.pid,
            ppid: undefined,
            sessionId: "sid-resolver",
          }),
        ],
        topics: [],
        registryIdFor: () => "sid-registry",
      },
      (m, c) => logs.push([m, c]),
    );
    expect(res.compared).toBe(0);
    expect(res.divergences).toBe(0);
    expect(logs.length).toBe(0);
  });
});
