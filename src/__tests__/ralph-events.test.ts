import { describe, it, expect } from "bun:test";
import { RalphLogParser } from "../ralph/events";

describe("RalphLogParser", () => {
  it("parses each terminal marker", () => {
    const p = new RalphLogParser();
    expect(p.push("=== Iteration 3/10 ===\n")).toEqual([
      { type: "iteration", n: 3, total: 10 },
    ]);
    expect(p.push("No open issues. All done!\n")).toEqual([
      { type: "no-issues" },
    ]);
    expect(p.push("Waiting for other agents to complete...\n")).toEqual([
      { type: "waiting" },
    ]);
    expect(p.push("All issues resolved after 7 iterations.\n")).toEqual([
      { type: "complete", iterations: 7 },
    ]);
    expect(p.push("Timeout after 1800s — killing session\n")).toEqual([
      { type: "timeout", seconds: 1800 },
    ]);
    expect(p.push("Reached max iterations (10)\n")).toEqual([
      { type: "max-iterations", n: 10 },
    ]);
  });

  it("strips ANSI CSI escapes wrapping a marker line", () => {
    const p = new RalphLogParser();
    const line = "\x1b[32m=== Iteration 1/2 ===\x1b[0m\n";
    expect(p.push(line)).toEqual([{ type: "iteration", n: 1, total: 2 }]);
  });

  it("takes content after the last carriage return (TUI overwrite)", () => {
    const p = new RalphLogParser();
    // A spinner frame rewritten to the terminal marker on the same row.
    const line = "  ⠋ working\r=== Iteration 5/5 ===\n";
    expect(p.push(line)).toEqual([{ type: "iteration", n: 5, total: 5 }]);
  });

  it("buffers a line split across chunks", () => {
    const p = new RalphLogParser();
    expect(p.push("=== Iterat")).toEqual([]);
    expect(p.push("ion 2/4 ===\n")).toEqual([
      { type: "iteration", n: 2, total: 4 },
    ]);
  });

  it("does NOT match indented TUI lookalike text", () => {
    const p = new RalphLogParser();
    // Claude's TUI renders quoted/boxed text indented — never at column 0.
    expect(p.push("   === Iteration 9/9 ===\n")).toEqual([]);
    expect(p.push("│ No open issues. All done!\n")).toEqual([]);
  });

  it("preserves order across a multi-event chunk", () => {
    const p = new RalphLogParser();
    const chunk =
      "=== Iteration 1/3 ===\nsome noise\nWaiting for other agents\n" +
      "=== Iteration 2/3 ===\nAll issues resolved after 2 iterations.\n";
    expect(p.push(chunk)).toEqual([
      { type: "iteration", n: 1, total: 3 },
      { type: "waiting" },
      { type: "iteration", n: 2, total: 3 },
      { type: "complete", iterations: 2 },
    ]);
  });

  it("drops non-marker lines", () => {
    const p = new RalphLogParser();
    expect(p.push("First run - full fetch (with body, comments)\n")).toEqual(
      [],
    );
    expect(p.push("Tasks exist - slim fetch (number, title only)\n")).toEqual(
      [],
    );
  });

  it("stays coupled to the vendored script's echo lines", async () => {
    // The six regexes silently stop matching if scripts/ralph/afk_tasks.sh
    // rewords its echoes — the loop would run with zero beats posted. Guard
    // the coupling from the script side: every marker's literal echo prefix
    // must still be present in the script source.
    const script = await Bun.file(
      new URL("../../scripts/ralph/afk_tasks.sh", import.meta.url),
    ).text();
    const echoPrefixes = [
      'echo "=== Iteration $i/$ITERATIONS ==="',
      'echo "No open issues. All done!"',
      'echo "Waiting for other agents',
      'echo "All issues resolved after $i iterations."',
      'echo "Timeout after ${TIMEOUT}s',
      'echo "Reached max iterations ($ITERATIONS)"',
    ];
    for (const prefix of echoPrefixes) {
      expect(script).toContain(prefix);
    }
    // And the parser recognizes each echo with variables substituted.
    const p = new RalphLogParser();
    const rendered =
      "=== Iteration 1/5 ===\n" +
      "No open issues. All done!\n" +
      "Waiting for other agents to complete blocking tasks...\n" +
      "All issues resolved after 1 iterations.\n" +
      "Timeout after 1800s — killing session\n" +
      "Reached max iterations (5)\n";
    expect(p.push(rendered).map((e) => e.type)).toEqual([
      "iteration",
      "no-issues",
      "waiting",
      "complete",
      "timeout",
      "max-iterations",
    ]);
  });
});
