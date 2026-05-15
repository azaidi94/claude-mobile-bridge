import "./ensure-test-env";
import { describe, test, expect } from "bun:test";

async function load() {
  return import(`${import.meta.dir}/../../hooks/claude-remote-auq-worker.ts`);
}

describe("worker: paneContains (send-and-verify guard)", () => {
  test("matches the question head within a rendered pane", async () => {
    const { paneContains } = await load();
    const pane = [
      "  Some earlier output",
      "  ╭─ Claude needs your input ─────────────╮",
      "  │ Which database should we use for this │",
      "  │ migration?                            │",
      "  │  1. Postgres                          │",
      "  │  2. MySQL                             │",
      "  ╰───────────────────────────────────────╯",
    ].join("\n");
    expect(
      paneContains(pane, "Which database should we use for this migration?"),
    ).toBe(true);
  });

  test("returns false when the question is no longer on screen", async () => {
    const { paneContains } = await load();
    const pane = [
      "  ╭─ Bash command ────────────────────────╮",
      "  │ rm -rf ./build                        │",
      "  │  1. Yes   2. No                       │",
      "  ╰───────────────────────────────────────╯",
    ].join("\n");
    expect(
      paneContains(pane, "Which database should we use for this migration?"),
    ).toBe(false);
  });

  test("tolerates collapsed whitespace from TUI line-wrapping", async () => {
    const { paneContains } = await load();
    // The needle head spans a wrapped line break in the pane.
    const pane = "│ Pick an approach for the\n│ refactor please │";
    expect(paneContains(pane, "Pick an approach for the refactor")).toBe(true);
  });

  test("short strings fall back to an exact substring check", async () => {
    const { paneContains } = await load();
    expect(paneContains("the answer is yes here", "yes", 6)).toBe(true);
    expect(paneContains("no match in here", "yes", 6)).toBe(false);
  });

  test("empty needle never matches", async () => {
    const { paneContains } = await load();
    expect(paneContains("anything at all", "")).toBe(false);
    expect(paneContains("anything at all", "   ")).toBe(false);
  });
});
