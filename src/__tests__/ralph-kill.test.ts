import { describe, it, expect } from "bun:test";
import { collectTree } from "../ralph/tree";

describe("collectTree", () => {
  it("returns just the root when it has no children", async () => {
    const pgrep = async () => [];
    expect(await collectTree(100, pgrep)).toEqual([100]);
  });

  it("walks a deep tree depth-first", async () => {
    // 100 → 200 → 400 ; 100 → 300
    const children: Record<number, number[]> = {
      100: [200, 300],
      200: [400],
      300: [],
      400: [],
    };
    const pgrep = async (pid: number) => children[pid] ?? [];
    expect(await collectTree(100, pgrep)).toEqual([100, 200, 400, 300]);
  });

  it("handles pids with no mapping (missing / already-dead)", async () => {
    const children: Record<number, number[]> = { 100: [200] };
    const pgrep = async (pid: number) => children[pid] ?? [];
    // 200 has no entry → treated as leaf
    expect(await collectTree(100, pgrep)).toEqual([100, 200]);
  });
});
