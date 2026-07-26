import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runCli } from "../ralph/tasks-queue-cli";

const SAMPLE = `# Plan: demo

## [ ] 1. First
**Depends on:** none

## [ ] 2. Second
**Depends on:** 1
`;

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tq-cli-"));
  file = join(dir, "tasks.md");
  writeFileSync(file, SAMPLE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("tasks-queue-cli: next", () => {
  it("returns the ready item with id and block", () => {
    const out = JSON.parse(runCli(["next", file]));
    expect(out.status).toBe("ready");
    expect(out.id).toBe(1);
    expect(out.block).toContain("## [ ] 1. First");
  });

  it("returns complete when the file is missing", () => {
    const out = JSON.parse(runCli(["next", join(dir, "nope.md")]));
    expect(out.status).toBe("complete");
  });

  // The silent-success trap: a hand-edit that parses to zero items used to
  // report "complete", and the loop exited 0 having run nothing.
  it("reports malformed — not complete — for a near-miss header", () => {
    writeFileSync(file, "# Plan: demo\n\n## [ ] 1: First\n");
    const out = JSON.parse(runCli(["next", file]));
    expect(out.status).toBe("malformed");
    expect(out.error).toContain("1: First");
  });

  it("reports malformed for a non-empty file with no items at all", () => {
    writeFileSync(file, "# Plan: demo\n\nsome prose, no items\n");
    expect(JSON.parse(runCli(["next", file])).status).toBe("malformed");
  });

  it("still reports complete for an all-done queue", () => {
    writeFileSync(file, "# Plan: demo\n\n## [x] 1. First\n");
    expect(JSON.parse(runCli(["next", file])).status).toBe("complete");
  });
});

describe("tasks-queue-cli: done", () => {
  it("flips the item in the file on disk", () => {
    runCli(["done", file, "1"]);
    expect(readFileSync(file, "utf8")).toContain("## [x] 1. First");
    const out = JSON.parse(runCli(["next", file]));
    expect(out.id).toBe(2);
  });

  it("is idempotent on an already-done item", () => {
    runCli(["done", file, "1"]);
    expect(() => runCli(["done", file, "1"])).not.toThrow();
    expect(readFileSync(file, "utf8")).toContain("## [x] 1. First");
  });

  // A no-op flip would leave the loop re-serving the same task every iteration.
  it("throws when there is no such item to flip", () => {
    expect(() => runCli(["done", file, "9"])).toThrow(/no item 9/);
  });
});
