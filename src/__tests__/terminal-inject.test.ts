/**
 * Unit tests for the pure pieces of terminal-inject.ts — the per-app argv /
 * AppleScript builders, the pid→tty ancestor walk, and the cmux ref registry.
 * The live osascript/cmux/ps calls are not exercised here.
 */

import "./ensure-test-env";
import { describe, expect, test, beforeEach } from "bun:test";
import {
  parseCmuxRef,
  rememberCmuxWorkspace,
  getCmuxWorkspace,
  _resetCmuxRegistry,
  buildCmuxInjectArgvs,
  buildTtyWriteScript,
  buildGhosttyKeystrokeScript,
  ttyChainForPid,
  resolveCmuxWorkspace,
  detectTerminalApp,
  type PsRow,
  type ProcRow,
} from "../handlers/commands/terminal-inject";
import type { SessionContext } from "../sessions/context";
import type { PortFileData } from "../relay";

function sctx(over: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: "sid-1",
    sessionDir: "/tmp",
    source: "cc",
    chatId: 1,
    sessionName: "s",
    ...over,
  };
}

function portFile(over: Partial<PortFileData>): PortFileData {
  return {
    port: 9910,
    pid: 100,
    ppid: 50,
    cwd: "/tmp",
    startedAt: "2026-06-27T00:00:00Z",
    ...over,
  };
}

describe("parseCmuxRef", () => {
  test("extracts the workspace ref from `OK workspace:N` stdout", () => {
    expect(parseCmuxRef("OK workspace:80")).toBe("workspace:80");
    expect(parseCmuxRef("workspace:1\n")).toBe("workspace:1");
  });

  test("supports uuid-form refs", () => {
    expect(parseCmuxRef("OK workspace:3f2a1b9c-dead")).toBe(
      "workspace:3f2a1b9c-dead",
    );
  });

  test("returns null when no ref is present", () => {
    expect(parseCmuxRef("")).toBeNull();
    expect(parseCmuxRef("error: nope")).toBeNull();
  });

  test("prefers the ref on the OK line over an earlier distractor ref", () => {
    expect(parseCmuxRef("warning: workspace:1 is busy\nOK workspace:80")).toBe(
      "workspace:80",
    );
  });
});

describe("cmux workspace registry", () => {
  beforeEach(() => _resetCmuxRegistry());

  test("remembers and resolves a ref by cwd", () => {
    rememberCmuxWorkspace("/tmp", "OK workspace:42");
    // /tmp canonicalizes to /private/tmp on macOS; look it up via the same path.
    expect(getCmuxWorkspace("/tmp")).toBe("workspace:42");
  });

  test("ignores stdout with no ref", () => {
    rememberCmuxWorkspace("/tmp", "garbage");
    expect(getCmuxWorkspace("/tmp")).toBeUndefined();
  });

  test("unknown cwd resolves to undefined", () => {
    expect(getCmuxWorkspace("/no/such/dir/ever")).toBeUndefined();
  });
});

describe("buildCmuxInjectArgvs", () => {
  test("targets --workspace with a UUID (port-file path) + submitting Enter", () => {
    expect(buildCmuxInjectArgvs("cmux", "6F24435C-DFEE", "/clear")).toEqual([
      ["cmux", "send", "--workspace", "6F24435C-DFEE", "--", "/clear"],
      ["cmux", "send-key", "--workspace", "6F24435C-DFEE", "Enter"],
    ]);
  });

  test("targets --workspace with a short ref (spawn-registry fallback)", () => {
    const [send] = buildCmuxInjectArgvs("cmux", "workspace:5", "/compact");
    expect(send).toEqual([
      "cmux",
      "send",
      "--workspace",
      "workspace:5",
      "--",
      "/compact",
    ]);
  });

  test("passes text as a single argv element (no shell, leading slash safe)", () => {
    const send = buildCmuxInjectArgvs("cmux", "workspace:5", "/compact")[0]!;
    expect(send[send.length - 1]).toBe("/compact");
  });
});

describe("buildTtyWriteScript", () => {
  test("iterm2 writes text to the session whose tty matches", () => {
    const s = buildTtyWriteScript("iterm2", ["/dev/ttys003"], "/clear");
    expect(s).toContain('tell application "iTerm2"');
    expect(s).toContain('set ttyList to {"/dev/ttys003"}');
    expect(s).toContain('write text "/clear"');
  });

  test("terminal uses do script in the matching tab", () => {
    const s = buildTtyWriteScript("terminal", ["/dev/ttys003"], "/compact");
    expect(s).toContain('tell application "Terminal"');
    expect(s).toContain('do script "/compact" in t');
  });

  test("returns 1 on a match and 0 on none (so a silent no-match isn't success)", () => {
    for (const app of ["iterm2", "terminal"] as const) {
      const s = buildTtyWriteScript(app, ["/dev/ttys003"], "/clear");
      expect(s).toContain("return 1");
      expect(s.trimEnd()).toEndWith("return 0");
    }
  });

  test("escapes double quotes in the injected text", () => {
    const s = buildTtyWriteScript("iterm2", ["/dev/ttys003"], 'say "hi"');
    expect(s).toContain('write text "say \\"hi\\""');
  });

  test("includes every candidate tty in the list", () => {
    const s = buildTtyWriteScript(
      "iterm2",
      ["/dev/ttys003", "/dev/ttys009"],
      "/clear",
    );
    expect(s).toContain('{"/dev/ttys003", "/dev/ttys009"}');
  });
});

describe("buildGhosttyKeystrokeScript", () => {
  test("activates Ghostty then keystrokes the text + return", () => {
    const s = buildGhosttyKeystrokeScript("/clear");
    expect(s).toContain('tell application "Ghostty" to activate');
    expect(s).toContain('keystroke "/clear"');
    expect(s).toContain("key code 36");
  });
});

describe("resolveCmuxWorkspace", () => {
  beforeEach(() => _resetCmuxRegistry());

  test("prefers the workspace UUID from the matched port file", async () => {
    const scan = async () => [
      portFile({ sessionId: "sid-1", cmuxWorkspaceId: "WS-UUID" }),
    ];
    expect(await resolveCmuxWorkspace(sctx({ sessionId: "sid-1" }), scan)).toBe(
      "WS-UUID",
    );
  });

  test("falls back to the spawn-registry ref when the port file lacks the id", async () => {
    rememberCmuxWorkspace("/tmp", "OK workspace:9");
    const scan = async () => [portFile({ sessionId: "sid-1" })]; // no cmuxWorkspaceId
    expect(await resolveCmuxWorkspace(sctx({ sessionId: "sid-1" }), scan)).toBe(
      "workspace:9",
    );
  });

  test("recovers the id by unique cwd match when the sessionId has drifted", async () => {
    // Port file's sessionId differs (e.g. a /clear changed the live id), so the
    // sessionId lookup misses — but the cwd uniquely identifies it.
    const scan = async () => [
      portFile({ sessionId: "old-id", cwd: "/tmp", cmuxWorkspaceId: "WS-DIR" }),
    ];
    expect(
      await resolveCmuxWorkspace(sctx({ sessionId: "new-id" }), scan),
    ).toBe("WS-DIR");
  });

  test("does NOT dir-match when two port files share the cwd (ambiguous)", async () => {
    const scan = async () => [
      portFile({ sessionId: "a", cwd: "/tmp", cmuxWorkspaceId: "WS-A" }),
      portFile({ sessionId: "b", cwd: "/tmp", cmuxWorkspaceId: "WS-B" }),
    ];
    expect(
      await resolveCmuxWorkspace(sctx({ sessionId: "new-id" }), scan),
    ).toBeNull();
  });

  test("returns null (never an empty ref) when nothing is known", async () => {
    const scan = async () => [];
    expect(
      await resolveCmuxWorkspace(sctx({ sessionDir: "/no/dir" }), scan),
    ).toBeNull();
  });

  test("survives a scan that throws, still trying the registry", async () => {
    rememberCmuxWorkspace("/tmp", "OK workspace:3");
    const scan = async () => {
      throw new Error("boom");
    };
    expect(await resolveCmuxWorkspace(sctx(), scan)).toBe("workspace:3");
  });
});

describe("detectTerminalApp", () => {
  // Real ancestry observed for a cmux-hosted claude:
  //   claude → expect → bash → zsh → login → /Applications/cmux.app/.../cmux
  const cmuxTree: Record<number, ProcRow> = {
    3313: { ppid: 3309, comm: "/Users/ali/.local/bin/claude" },
    3309: { ppid: 3301, comm: "/usr/bin/expect" },
    3301: { ppid: 3187, comm: "bash" },
    3187: { ppid: 3186, comm: "-/bin/zsh" },
    3186: { ppid: 64752, comm: "/usr/bin/login" },
    64752: { ppid: 1, comm: "/Applications/cmux.app/Contents/MacOS/cmux" },
  };

  test("detects cmux from a deep ancestor (past expect/login)", () => {
    expect(detectTerminalApp(3313, (p) => cmuxTree[p] ?? null)).toBe("cmux");
  });

  test("detects Apple Terminal", () => {
    const tree: Record<number, ProcRow> = {
      10: { ppid: 9, comm: "/Users/x/.local/bin/claude" },
      9: { ppid: 8, comm: "-zsh" },
      8: {
        ppid: 1,
        comm: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
      },
    };
    expect(detectTerminalApp(10, (p) => tree[p] ?? null)).toBe("terminal");
  });

  test("detects iTerm2", () => {
    const tree: Record<number, ProcRow> = {
      10: { ppid: 9, comm: "claude" },
      9: { ppid: 1, comm: "/Applications/iTerm.app/Contents/MacOS/iTerm2" },
    };
    expect(detectTerminalApp(10, (p) => tree[p] ?? null)).toBe("iterm2");
  });

  test("detects standalone Ghostty", () => {
    const tree: Record<number, ProcRow> = {
      10: { ppid: 9, comm: "claude" },
      9: { ppid: 1, comm: "/Applications/Ghostty.app/Contents/MacOS/ghostty" },
    };
    expect(detectTerminalApp(10, (p) => tree[p] ?? null)).toBe("ghostty");
  });

  test("prefers cmux over ghostty (cmux embeds Ghostty)", () => {
    // A path containing both — cmux must win (it's matched first).
    const tree: Record<number, ProcRow> = {
      10: { ppid: 9, comm: "claude" },
      9: {
        ppid: 1,
        comm: "/Applications/cmux.app/Contents/Resources/ghostty/bin/cmux",
      },
    };
    expect(detectTerminalApp(10, (p) => tree[p] ?? null)).toBe("cmux");
  });

  test("returns undefined for an unrecognised host (caller uses global default)", () => {
    const tree: Record<number, ProcRow> = {
      10: { ppid: 9, comm: "claude" },
      9: { ppid: 1, comm: "/usr/bin/tmux" },
    };
    expect(detectTerminalApp(10, (p) => tree[p] ?? null)).toBeUndefined();
  });

  test("returns undefined on a broken ancestry chain", () => {
    expect(detectTerminalApp(999, () => null)).toBeUndefined();
  });
});

describe("ttyChainForPid", () => {
  // Models the expect-launcher tree: claude on inner pty ttys999, its ancestor
  // (the login shell) on the terminal-window tty ttys003.
  const tree: Record<number, PsRow> = {
    500: { ppid: 400, tty: "/dev/ttys999" }, // claude (inner pty)
    400: { ppid: 300, tty: "/dev/ttys003" }, // expect (owns the window tty)
    300: { ppid: 1, tty: "/dev/ttys003" }, // login shell
  };
  const lookup = (p: number): PsRow | null => tree[p] ?? null;

  test("collects the pid's tty and all ancestor ttys (deduped)", () => {
    const ttys = ttyChainForPid(500, lookup);
    expect(ttys.sort()).toEqual(["/dev/ttys003", "/dev/ttys999"]);
  });

  test("direct-exec case yields just the one tty", () => {
    const direct = (p: number): PsRow | null =>
      p === 500 ? { ppid: 1, tty: "/dev/ttys003" } : null;
    expect(ttyChainForPid(500, direct)).toEqual(["/dev/ttys003"]);
  });

  test("skips processes with no controlling tty", () => {
    const withNull: Record<number, PsRow> = {
      500: { ppid: 400, tty: null },
      400: { ppid: 1, tty: "/dev/ttys003" },
    };
    expect(ttyChainForPid(500, (p) => withNull[p] ?? null)).toEqual([
      "/dev/ttys003",
    ]);
  });

  test("terminates on a broken chain without looping forever", () => {
    expect(ttyChainForPid(999, () => null)).toEqual([]);
  });
});
