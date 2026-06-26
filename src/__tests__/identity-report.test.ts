import { describe, test, expect } from "bun:test";
import { reportIdentityViolations } from "../sessions/identity-report";
import type { PortFileData } from "../relay/discovery";

const relay = (o: Partial<PortFileData>): PortFileData =>
  ({
    port: 1,
    pid: process.pid,
    ppid: 9,
    cwd: "/p",
    startedAt: "2026-01-01T00:00:00Z",
    ...o,
  }) as PortFileData;

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
});
