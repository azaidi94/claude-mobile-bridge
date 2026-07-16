/**
 * Unit tests for `_resolveIterationClaude` (ralph/monitor): identify the loop's
 * current iteration claude by walking the runner's process tree and matching a
 * relay port file whose spawning PID is in the tree and whose cwd is the repo.
 * pgrep + port-file scan are injected so no real processes/files are touched.
 */

import { describe, it, expect } from "bun:test";
import type { RalphLoop } from "../ralph/store";
import type { PortFileData } from "../relay";

const baseLoop = (over: Partial<RalphLoop> = {}): RalphLoop =>
  ({
    id: "abc",
    repoPath: "/repo",
    iterations: 10,
    prMode: false,
    runDir: "/run",
    tailOffset: 0,
    verbose: false,
    startedAt: "2026-07-05T00:00:00.000Z",
    state: "running",
    pid: 1000,
    ...over,
  }) as RalphLoop;

const port = (over: Partial<PortFileData>): PortFileData => ({
  port: 5000,
  pid: 42,
  ppid: 100,
  sessionId: "sess-id",
  cwd: "/repo",
  startedAt: "2026-07-05T00:00:00.000Z",
  ...over,
});

// tree: runner(1000) → child(100) → grandchild(200)
const treePgrep =
  (map: Record<number, number[]>) =>
  async (pid: number): Promise<number[]> =>
    map[pid] ?? [];

describe("_resolveIterationClaude", () => {
  it("returns null when the loop has no pid", async () => {
    const { _resolveIterationClaude } = await import("../ralph/monitor");
    const res = await _resolveIterationClaude(baseLoop({ pid: undefined }), {
      pgrep: async () => [200],
      scan: async () => [port({ ppid: 200 })],
    });
    expect(res).toBeNull();
  });

  it("returns null when the process tree is empty", async () => {
    const { _resolveIterationClaude } = await import("../ralph/monitor");
    // collectTree always includes the root, so an "empty tree" only happens
    // when pgrep throws — collectTree's .catch() yields [].
    const res = await _resolveIterationClaude(baseLoop(), {
      pgrep: async () => {
        throw new Error("boom");
      },
      scan: async () => [port({ ppid: 1000 })],
    });
    expect(res).toBeNull();
  });

  it("pins the port file whose ppid is in the tree and cwd is the repo", async () => {
    const { _resolveIterationClaude } = await import("../ralph/monitor");
    const loop = baseLoop({ id: "xyz" });
    const res = await _resolveIterationClaude(loop, {
      pgrep: treePgrep({ 1000: [100], 100: [200] }),
      scan: async () => [
        port({ ppid: 200, sessionId: "iter-live-id", cwd: "/repo" }),
      ],
    });
    expect(res).toEqual({
      id: "iter-live-id",
      name: "ralph:xyz", // synthetic name — never the collapsed registry entry
      dir: "/repo", // the matched port file's OWN cwd
      lastActivity: expect.any(Number),
      source: "desktop",
      pid: 200, // pid = the port file's ppid (the Claude PID)
    });
  });

  it("ignores a port file in the tree but rooted in the wrong dir", async () => {
    const { _resolveIterationClaude } = await import("../ralph/monitor");
    const res = await _resolveIterationClaude(baseLoop(), {
      pgrep: treePgrep({ 1000: [100] }),
      scan: async () => [port({ ppid: 100, cwd: "/other" })],
    });
    expect(res).toBeNull();
  });

  it("ignores a repo port file whose ppid is NOT in the tree", async () => {
    const { _resolveIterationClaude } = await import("../ralph/monitor");
    const res = await _resolveIterationClaude(baseLoop(), {
      pgrep: treePgrep({ 1000: [100] }),
      scan: async () => [port({ ppid: 999, cwd: "/repo" })],
    });
    expect(res).toBeNull();
  });

  it("prefers the newest match when a stale iteration's relay overlaps", async () => {
    const { _resolveIterationClaude } = await import("../ralph/monitor");
    const res = await _resolveIterationClaude(baseLoop(), {
      pgrep: treePgrep({ 1000: [100, 200] }),
      scan: async () => [
        port({
          ppid: 100,
          sessionId: "stale",
          startedAt: "2026-07-05T00:00:00.000Z",
        }),
        port({
          ppid: 200,
          sessionId: "fresh",
          startedAt: "2026-07-05T00:05:00.000Z",
        }),
      ],
    });
    expect(res?.id).toBe("fresh");
    expect(res?.pid).toBe(200);
  });
});
