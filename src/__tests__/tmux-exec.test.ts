import { test, expect, describe } from "bun:test";
import { tmuxBase, isNoServer, capturePane } from "../tmux/exec";

describe("tmuxBase", () => {
  test("defaults to the -L claude socket name", () => {
    expect(tmuxBase()).toEqual(["tmux", "-L", "claude"]);
    expect(tmuxBase({})).toEqual(["tmux", "-L", "claude"]);
  });

  test("uses -S with an explicit socket path", () => {
    expect(tmuxBase({ socket: "/tmp/tmux-501/claude" })).toEqual([
      "tmux",
      "-S",
      "/tmp/tmux-501/claude",
    ]);
  });
});

describe("isNoServer", () => {
  test("true for a genuinely absent server", () => {
    expect(isNoServer("no server running on /tmp/tmux-501/claude")).toBe(true);
    expect(isNoServer("error connecting to /tmp/x (No such file)")).toBe(true);
  });

  test("false for a missing tmux binary — that is a real failure", () => {
    expect(
      isNoServer("tmux not runnable: ENOENT no such file or directory"),
    ).toBe(false);
  });
});

describe("capturePane", () => {
  test("returns empty string when the pane does not exist", () => {
    // %999999 cannot exist; tmux exits non-zero (or there is no server at all).
    // Either way the contract is the same: "" means UNKNOWN, never proceed.
    expect(capturePane({ pane: "%999999" })).toBe("");
  });
});
