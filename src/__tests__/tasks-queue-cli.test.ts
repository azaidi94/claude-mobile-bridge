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
});

describe("tasks-queue-cli: done", () => {
  it("flips the item in the file on disk", () => {
    runCli(["done", file, "1"]);
    expect(readFileSync(file, "utf8")).toContain("## [x] 1. First");
    const out = JSON.parse(runCli(["next", file]));
    expect(out.id).toBe(2);
  });
});
