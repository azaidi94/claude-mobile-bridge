import { test, expect } from "bun:test";
import {
  osParentPid,
  parentIsGone,
  type ParentProbes,
} from "./parent-watchdog";

function probes(over: Partial<ParentProbes>): ParentProbes {
  return {
    currentPpid: () => 100,
    isAlive: () => true,
    ...over,
  };
}

test("parentIsGone: unchanged parent pid means the parent is still ours", () => {
  expect(parentIsGone(100, probes({ currentPpid: () => 100 }))).toBe(false);
});

test("parentIsGone: reparented to init means the parent died", () => {
  expect(parentIsGone(100, probes({ currentPpid: () => 1 }))).toBe(true);
});

test("parentIsGone: reparenting wins over a pid-reuse false positive", () => {
  // The original pid has been recycled by an unrelated process, so the liveness
  // probe says "alive" — the OS ppid is the only signal that catches this.
  const p = probes({ currentPpid: () => 1, isAlive: () => true });

  expect(parentIsGone(100, p)).toBe(true);
});

test("parentIsGone: falls back to liveness when ps is unreadable", () => {
  expect(
    parentIsGone(
      100,
      probes({ currentPpid: () => null, isAlive: () => false }),
    ),
  ).toBe(true);
  expect(
    parentIsGone(100, probes({ currentPpid: () => null, isAlive: () => true })),
  ).toBe(false);
});

test("osParentPid reports this process's real parent", () => {
  // Guards the `ps -o ppid=` parse. process.ppid is snapshotted at startup
  // under Bun, but for a process whose parent is still alive it agrees.
  expect(osParentPid()).toBe(process.ppid);
});
