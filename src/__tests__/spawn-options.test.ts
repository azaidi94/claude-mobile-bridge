import { describe, test, expect } from "bun:test";
import {
  spawnExtraArgs,
  buildDesktopShellCommand,
} from "../handlers/commands/terminal-launchers";

describe("spawnExtraArgs", () => {
  test("no options → no args", () => expect(spawnExtraArgs()).toEqual([]));
  test("resume", () =>
    expect(spawnExtraArgs({ resumeSessionId: "abc" })).toEqual([
      "--resume",
      "abc",
    ]));
  test("branch = resume + fork", () =>
    expect(spawnExtraArgs({ resumeSessionId: "abc", fork: true })).toEqual([
      "--resume",
      "abc",
      "--fork-session",
    ]));
  test("fork without an id is ignored", () =>
    expect(spawnExtraArgs({ fork: true })).toEqual([]));
});

describe("buildDesktopShellCommand with options", () => {
  const tpl = { template: "/s/launch.sh {dir}", defaultArgs: "--a --b" };
  test("template path: prefixes CLAUDE_RELAY_ARGS with defaults + extras", () => {
    expect(
      buildDesktopShellCommand(
        "/p/x",
        "/bin/claude",
        { resumeSessionId: "abc", fork: true },
        tpl,
      ),
    ).toBe(
      "CLAUDE_RELAY_ARGS='--a --b --resume abc --fork-session' /s/launch.sh '/p/x'",
    );
  });
  test("template path, no options: unchanged", () => {
    expect(
      buildDesktopShellCommand("/p/x", "/bin/claude", undefined, tpl),
    ).toBe("/s/launch.sh '/p/x'");
  });
  test("direct path: appends extras after default args", () => {
    expect(
      buildDesktopShellCommand(
        "/p/x",
        "/bin/claude",
        { resumeSessionId: "abc" },
        {
          template: "",
          defaultArgs: "--a",
        },
      ),
    ).toBe("cd '/p/x' && exec '/bin/claude' --a --resume abc");
  });
  test("direct path, no options: unchanged", () => {
    expect(
      buildDesktopShellCommand("/p/x", "/bin/claude", undefined, {
        template: "",
        defaultArgs: "--a",
      }),
    ).toBe("cd '/p/x' && exec '/bin/claude' --a");
  });
});
