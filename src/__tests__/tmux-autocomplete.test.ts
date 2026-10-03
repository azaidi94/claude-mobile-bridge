import { describe, test, expect } from "bun:test";
import { inputStillHolds } from "../tmux/autocomplete";

describe("inputStillHolds", () => {
  test("true when the typed command sits alone on the prompt line", () => {
    expect(
      inputStillHolds("  /branch   Create a branch\n❯ /branch\n──", "/branch"),
    ).toBe(true);
    expect(inputStillHolds("> /clear\n", "/clear")).toBe(true);
  });
  test("false when the prompt is empty or holds something else", () => {
    expect(inputStillHolds("❯ \n", "/branch")).toBe(false);
    expect(inputStillHolds("❯ /branch extra\n", "/branch")).toBe(false);
    expect(inputStillHolds("❯ /branches\n", "/branch")).toBe(false);
    expect(inputStillHolds("", "/branch")).toBe(false);
  });
  test("does not match the command merely mentioned in output", () => {
    expect(inputStillHolds("Use /branch to fork\n❯ \n", "/branch")).toBe(false);
  });
});
