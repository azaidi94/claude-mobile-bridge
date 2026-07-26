import { describe, it, expect } from "bun:test";
import {
  parseTasks,
  nextEligible,
  queueStatus,
  queueProblem,
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

describe("tasks-queue: queueProblem", () => {
  const check = (md: string) => queueProblem(md, parseTasks(md));

  it("passes a well-formed queue", () => {
    expect(check(SAMPLE)).toBeNull();
  });

  it("passes an empty/whitespace file (genuinely nothing to do)", () => {
    expect(check("")).toBeNull();
    expect(check("\n  \n")).toBeNull();
  });

  it.each([
    ["colon instead of period", "## [ ] 1: First"],
    ["indented header", "  ## [ ] 1. First"],
    ["uppercase X", "## [X] 1. First"],
    ["no space in the box", "## [] 1. First"],
    ["wrong heading level", "### [ ] 1. First"],
  ])("flags a near-miss header: %s", (_name, header) => {
    const problem = check(`# Plan: x\n\n${header}\n**Depends on:** none\n`);
    expect(problem).toContain("don't match");
    expect(problem).toContain(header.trim());
  });

  it("flags a non-empty file that yields no items", () => {
    expect(check("# Plan: x\n\njust prose\n")).toContain(
      "no `## [ ] N. Title`",
    );
  });

  it("does not flag ordinary prose headings", () => {
    expect(check(`${SAMPLE}\n## Notes\n\nsome context\n`)).toBeNull();
  });

  // False positives are worse than the hole they close: they abort a queue that
  // would have run fine.
  it("does not flag a sub-checklist inside a task body", () => {
    expect(check(`${SAMPLE}\n### [ ] unit tests green\n`)).toBeNull();
  });

  it("does not flag headers inside a fenced block", () => {
    // A task's Context quoting the tasks.md format, indented inside the fence.
    const md = `${SAMPLE}
**Context:** the format is

\`\`\`markdown
  ## [ ] 1. <title>
\`\`\`
`;
    expect(check(md)).toBeNull();
  });

  it("resumes checking after a fence closes", () => {
    const md = `${SAMPLE}
\`\`\`
## [ ] 3. inside a fence
\`\`\`

## [ ] 4: after the fence
`;
    expect(check(md)).toContain("4: after the fence");
    expect(check(md)).not.toContain("3.");
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

  // parseTasks normalises `01` → 1; without the `0*` the flip silently no-ops
  // AFTER the session has already merged its work.
  it("flips a zero-padded header", () => {
    expect(markDone("## [ ] 01. One\n", 1)).toContain("## [x] 01. One");
  });

  it("does not confuse id 1 with item 11", () => {
    const out = markDone("## [ ] 11. Eleven\n", 1);
    expect(out).toBe("## [ ] 11. Eleven\n");
  });
});
