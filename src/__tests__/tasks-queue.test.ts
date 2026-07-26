import { describe, it, expect } from "bun:test";
import {
  parseTasks,
  nextEligible,
  queueStatus,
  markDone,
} from "../ralph/tasks-queue";

const SAMPLE = `# Plan: demo

## [ ] 1. First thing
**Acceptance:** it works.
**Depends on:** none
**Context:** src/a.ts

## [ ] 2. Second thing
**Acceptance:** also works.
**Depends on:** 1
**Context:** src/b.ts
`;

describe("tasks-queue: parseTasks", () => {
  it("parses id, title, done, dependsOn, and block", () => {
    const items = parseTasks(SAMPLE);
    expect(items.map((i) => i.id)).toEqual([1, 2]);
    expect(items[0]!.title).toBe("First thing");
    expect(items[0]!.done).toBe(false);
    expect(items[0]!.dependsOn).toEqual([]);
    expect(items[1]!.dependsOn).toEqual([1]);
    expect(items[0]!.block).toContain("**Acceptance:** it works.");
    expect(items[0]!.block).not.toContain("Second thing");
  });

  it("reads a checked item as done", () => {
    const items = parseTasks(SAMPLE.replace("## [ ] 1.", "## [x] 1."));
    expect(items[0]!.done).toBe(true);
  });
});

describe("tasks-queue: nextEligible", () => {
  it("returns the lowest undone item whose deps are all done", () => {
    const items = parseTasks(SAMPLE);
    expect(nextEligible(items)!.id).toBe(1); // 2 is blocked by 1
  });

  it("advances once the blocker is done", () => {
    const items = parseTasks(SAMPLE.replace("## [ ] 1.", "## [x] 1."));
    expect(nextEligible(items)!.id).toBe(2);
  });

  it("returns null when all items are done", () => {
    const md = SAMPLE.replace("## [ ] 1.", "## [x] 1.").replace(
      "## [ ] 2.",
      "## [x] 2.",
    );
    expect(nextEligible(parseTasks(md))).toBeNull();
  });
});

describe("tasks-queue: queueStatus", () => {
  it("is ready when an eligible item exists", () => {
    expect(queueStatus(parseTasks(SAMPLE))).toBe("ready");
  });

  it("is complete when everything is done", () => {
    const md = SAMPLE.replace("## [ ] 1.", "## [x] 1.").replace(
      "## [ ] 2.",
      "## [x] 2.",
    );
    expect(queueStatus(parseTasks(md))).toBe("complete");
  });

  it("is waiting when undone items remain but none are eligible", () => {
    // Item 2 depends on missing id 9 → never satisfiable; item 1 removed.
    const blocked = `# Plan: x

## [ ] 2. Blocked
**Depends on:** 9
`;
    expect(queueStatus(parseTasks(blocked))).toBe("waiting");
  });
});

describe("tasks-queue: markDone", () => {
  it("flips only the targeted item's checkbox", () => {
    const out = markDone(SAMPLE, 1);
    expect(out).toContain("## [x] 1. First thing");
    expect(out).toContain("## [ ] 2. Second thing");
  });

  it("is idempotent on an already-done item", () => {
    const once = markDone(SAMPLE, 1);
    expect(markDone(once, 1)).toBe(once);
  });
});
