import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { inputStillHolds } from "../tmux/autocomplete";

const pane = (n: string): string =>
  readFileSync(
    join(import.meta.dir, "fixtures", "tmux-panes", `${n}.txt`),
    "utf8",
  );
const idle = pane("idle-bar");
const withInput = (text: string): string =>
  idle.replace("❯\u00a0", `❯\u00a0${text}`);

describe("inputStillHolds", () => {
  test("true when the input bar holds exactly the typed command", () => {
    expect(inputStillHolds(withInput("/branch"), "/branch")).toBe(true);
    expect(inputStillHolds(withInput("/clear"), "/clear")).toBe(true);
  });
  test("false when the bar is empty or holds something else", () => {
    expect(inputStillHolds(idle, "/branch")).toBe(false);
    expect(inputStillHolds(withInput("/branch extra"), "/branch")).toBe(false);
    expect(inputStillHolds(withInput("/branches"), "/branch")).toBe(false);
    expect(inputStillHolds("", "/branch")).toBe(false);
  });
  test("ignores the transcript echo of a submitted command (scrollback-quote has '❯ /model')", () => {
    expect(inputStillHolds(pane("scrollback-quote"), "/model")).toBe(false);
  });
});
