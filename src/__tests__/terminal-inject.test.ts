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
  buildCursorInjectScript,
  parseChord,
  resolveTmuxTarget,
  buildTmuxSendArgs,
  countSessionsInDir,
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

describe("parseChord", () => {
  test("parses a full modifier chord into AppleScript form", () => {
    expect(parseChord("ctrl+alt+cmd+t")).toEqual({
      key: "t",
      modifiers: ["control down", "option down", "command down"],
    });
  });

  test("accepts modifier aliases and a bare key", () => {
    expect(parseChord("control+option+command+j")).toEqual({
      key: "j",
      modifiers: ["control down", "option down", "command down"],
    });
    expect(parseChord("k")).toEqual({ key: "k", modifiers: [] });
  });

  test("returns null for empty/undefined", () => {
    expect(parseChord("")).toBeNull();
    expect(parseChord(undefined)).toBeNull();
  });
});

describe("buildCursorInjectScript", () => {
  const chord = parseChord("ctrl+alt+cmd+t");

  test("targets the window by folder title and returns OK on success", () => {
    const s = buildCursorInjectScript("saas-builder", "/clear", {
      focusChord: chord,
    });
    // window match on the folder basename
    expect(s).toContain(`(name of w) ends with "saas-builder"`);
    // sentinels for the ambiguous / not-found cases
    expect(s).toContain(`"ERR_NO_WINDOW"`);
    expect(s).toContain(`"ERR_MULTI_WINDOW"`);
    // verify-before-type guards
    expect(s).toContain(`"ERR_RAISE_FAILED"`);
    expect(s).toContain(`"ERR_NOT_TERMINAL_FOCUSED"`);
    // only types when a terminal actually holds focus
    expect(s).toContain(`does not start with "Terminal "`);
    // sends the focus chord before typing
    expect(s).toContain(
      `keystroke "t" using {control down, option down, command down}`,
    );
    // types the text and submits with Return
    expect(s).toContain(`keystroke "/clear"`);
    expect(s).toContain(`key code 36`);
    expect(s).toContain(`return "OK"`);
  });

  test("no focus chord → no focus keystroke (best-effort)", () => {
    const s = buildCursorInjectScript("proj", "/clear", { focusChord: null });
    expect(s).not.toContain(`using {`);
    expect(s).toContain(`keystroke "/clear"`);
  });

  test("submit=false types the text but omits the Return key (smoke test)", () => {
    const s = buildCursorInjectScript("proj", "marker", {
      submit: false,
      focusChord: null,
    });
    expect(s).toContain(`keystroke "marker"`);
    expect(s).not.toContain(`key code 36`);
  });

  test("escapes double quotes in folder and text", () => {
    const s = buildCursorInjectScript(`fo"o`, `ba"r`, { focusChord: null });
    expect(s).toContain(`fo\\"o`);
    expect(s).toContain(`ba\\"r`);
  });
});

describe("resolveTmuxTarget", () => {
  test("prefers the pane+socket from the exact sessionId match", async () => {
    const scan = async () => [
      portFile({
        sessionId: "sid-1",
        tmuxPane: "%3",
        tmuxSocket: "/tmp/tmux-501/claude",
      }),
    ];
    expect(await resolveTmuxTarget(sctx({ sessionId: "sid-1" }), scan)).toEqual(
      {
        pane: "%3",
        socket: "/tmp/tmux-501/claude",
      },
    );
  });

  test("recovers by unique cwd match when the sessionId has drifted", async () => {
    const scan = async () => [
      portFile({ sessionId: "old", cwd: "/tmp", tmuxPane: "%7" }),
    ];
    expect(await resolveTmuxTarget(sctx({ sessionId: "new" }), scan)).toEqual({
      pane: "%7",
      socket: undefined,
    });
  });

  test("does NOT cwd-match when two panes share the cwd (ambiguous)", async () => {
    const scan = async () => [
      portFile({ sessionId: "a", cwd: "/tmp", tmuxPane: "%1" }),
      portFile({ sessionId: "b", cwd: "/tmp", tmuxPane: "%2" }),
    ];
    expect(
      await resolveTmuxTarget(sctx({ sessionId: "new" }), scan),
    ).toBeNull();
  });

  test("returns null when the session isn't under tmux", async () => {
    const scan = async () => [portFile({ sessionId: "sid-1" })]; // no tmuxPane
    expect(
      await resolveTmuxTarget(sctx({ sessionId: "sid-1" }), scan),
    ).toBeNull();
  });

  test("refuses (does NOT borrow a sibling's pane) when the exact session has no pane", async () => {
    // The exact-id session is genuinely not under tmux; an unrelated sibling in
    // the same cwd IS. The cwd fallback must NOT fire here — injecting would land
    // in the sibling's pane. Positive identity wins → null (refuse/fail over).
    const scan = async () => [
      portFile({ sessionId: "sid-1", cwd: "/tmp" }), // this session, no pane
      portFile({ sessionId: "sib", cwd: "/tmp", tmuxPane: "%9" }), // sibling
    ];
    expect(
      await resolveTmuxTarget(sctx({ sessionId: "sid-1" }), scan),
    ).toBeNull();
  });

  test("anchors on the registry sessionId→launchUuid, defeating a sibling that stole the id even when the pid was mis-assigned", async () => {
    // Corruption: sibling B's port file was stamped with A's sessionId under
    // /clear churn, AND the watcher's 2nd-pass bridge mis-assigned A's session
    // record pid to B's claude pid (111). Anchoring on the authoritative
    // registry sessionId map (A's id → A's uuid) selects A's real port file (%A),
    // NOT the sibling's (%B) — the pid is not trusted for the target.
    const scan = async () => [
      portFile({ sessionId: "sid-1", ppid: 111, cwd: "/tmp", tmuxPane: "%B" }), // sibling B, stole A's id
      portFile({ sessionId: "old-a", ppid: 222, cwd: "/tmp", tmuxPane: "%A" }), // A's real port file
    ];
    const uuidForSessionId = (sid?: string) =>
      sid === "sid-1" ? "uA" : undefined; // registry: A's current id → A's uuid
    const uuidForPid = (pid?: number) =>
      pid === 222 ? "uA" : pid === 111 ? "uB" : undefined;
    expect(
      await resolveTmuxTarget(
        sctx({ sessionId: "sid-1", sessionPid: 111 }), // pid mis-assigned to B!
        scan,
        uuidForPid,
        uuidForSessionId,
      ),
    ).toEqual({ pane: "%A", socket: undefined });
  });

  test("refuses when the launchUuid session has no pane (does NOT borrow a sibling's)", async () => {
    const scan = async () => [
      portFile({ sessionId: "sib", ppid: 111, cwd: "/tmp", tmuxPane: "%B" }), // sibling under tmux
      portFile({ sessionId: "sid-1", ppid: 222, cwd: "/tmp" }), // A: no pane
    ];
    const uuidForSessionId = (sid?: string) =>
      sid === "sid-1" ? "uA" : undefined;
    const uuidForPid = (pid?: number) =>
      pid === 222 ? "uA" : pid === 111 ? "uB" : undefined;
    expect(
      await resolveTmuxTarget(
        sctx({ sessionId: "sid-1", sessionPid: 222 }),
        scan,
        uuidForPid,
        uuidForSessionId,
      ),
    ).toBeNull();
  });

  test("falls back to unique-cwd recovery when no launchUuid is known (R1)", async () => {
    const scan = async () => [
      portFile({ sessionId: "old", cwd: "/tmp", tmuxPane: "%7" }),
    ];
    const none = () => undefined; // Cursor/bare/offline — no registry entry
    expect(
      await resolveTmuxTarget(
        sctx({ sessionId: "new", sessionPid: 999 }),
        scan,
        none,
        none,
      ),
    ).toEqual({ pane: "%7", socket: undefined });
  });
});

describe("buildTmuxSendArgs", () => {
  test("sends literal text then a separate Enter, targeting the pane on its socket", () => {
    expect(
      buildTmuxSendArgs({ pane: "%3", socket: "/tmp/s" }, "/clear"),
    ).toEqual([
      ["tmux", "-S", "/tmp/s", "send-keys", "-t", "%3", "-l", "/clear"],
      ["tmux", "-S", "/tmp/s", "send-keys", "-t", "%3", "Enter"],
    ]);
  });

  test("omits -S when no socket is known (default server)", () => {
    expect(buildTmuxSendArgs({ pane: "%9" }, "/compact")).toEqual([
      ["tmux", "send-keys", "-t", "%9", "-l", "/compact"],
      ["tmux", "send-keys", "-t", "%9", "Enter"],
    ]);
  });
});

describe("countSessionsInDir", () => {
  test("counts only port files whose cwd matches", async () => {
    const scan = async () => [
      portFile({ sessionId: "a", cwd: "/tmp" }),
      portFile({ sessionId: "b", cwd: "/tmp" }),
      portFile({ sessionId: "c", cwd: "/other" }),
    ];
    expect(await countSessionsInDir("/tmp", scan)).toBe(2);
    expect(await countSessionsInDir("/other", scan)).toBe(1);
    expect(await countSessionsInDir("/nope", scan)).toBe(0);
  });

  test("fails closed (reports >1) when the scan throws", async () => {
    const scan = async () => {
      throw new Error("boom");
    };
    expect(await countSessionsInDir("/tmp", scan)).toBeGreaterThan(1);
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

  test("anchors on the registry sessionId→launchUuid, defeating a sibling that stole the id even when the pid was mis-assigned", async () => {
    const scan = async () => [
      portFile({
        sessionId: "sid-1",
        ppid: 111,
        cwd: "/tmp",
        cmuxWorkspaceId: "WS-B",
      }), // sibling B, stole A's id
      portFile({
        sessionId: "old-a",
        ppid: 222,
        cwd: "/tmp",
        cmuxWorkspaceId: "WS-A",
      }), // A's real port file
    ];
    const uuidForSessionId = (sid?: string) =>
      sid === "sid-1" ? "uA" : undefined;
    const uuidForPid = (pid?: number) =>
      pid === 222 ? "uA" : pid === 111 ? "uB" : undefined;
    expect(
      await resolveCmuxWorkspace(
        sctx({ sessionId: "sid-1", sessionPid: 111 }), // pid mis-assigned to B!
        scan,
        uuidForPid,
        uuidForSessionId,
      ),
    ).toBe("WS-A");
  });

  test("launchUuid match without a workspace id refuses when a sibling shares the cwd (spawn-registry is cwd-keyed)", async () => {
    // The cwd-keyed spawn registry (last /new spawn in a dir wins) can hold a
    // sibling's ref, so it must NOT be trusted when a sibling shares the cwd.
    rememberCmuxWorkspace("/tmp", "OK workspace:5");
    const scan = async () => [
      portFile({
        sessionId: "sib",
        ppid: 111,
        cwd: "/tmp",
        cmuxWorkspaceId: "WS-SIB",
      }), // sibling shares the cwd
      portFile({ sessionId: "sid-1", ppid: 222, cwd: "/tmp" }), // A: no id
    ];
    const uuidForSessionId = (sid?: string) =>
      sid === "sid-1" ? "uA" : undefined;
    const uuidForPid = (pid?: number) =>
      pid === 222 ? "uA" : pid === 111 ? "uB" : undefined;
    expect(
      await resolveCmuxWorkspace(
        sctx({ sessionId: "sid-1", sessionPid: 222 }),
        scan,
        uuidForPid,
        uuidForSessionId,
      ),
    ).toBeNull();
  });

  test("launchUuid match without a workspace id uses the spawn-registry when alone in the cwd", async () => {
    rememberCmuxWorkspace("/tmp", "OK workspace:5");
    const scan = async () => [
      portFile({ sessionId: "sid-1", ppid: 222, cwd: "/tmp" }), // A alone, no id
    ];
    const uuidForSessionId = (sid?: string) =>
      sid === "sid-1" ? "uA" : undefined;
    const uuidForPid = (pid?: number) => (pid === 222 ? "uA" : undefined);
    expect(
      await resolveCmuxWorkspace(
        sctx({ sessionId: "sid-1", sessionPid: 222 }),
        scan,
        uuidForPid,
        uuidForSessionId,
      ),
    ).toBe("workspace:5");
  });

  test("falls back to unique-cwd recovery when no launchUuid is known (R1)", async () => {
    const scan = async () => [
      portFile({ sessionId: "old-id", cwd: "/tmp", cmuxWorkspaceId: "WS-DIR" }),
    ];
    const none = () => undefined; // Cursor/bare/offline — no registry entry
    expect(
      await resolveCmuxWorkspace(
        sctx({ sessionId: "new-id", sessionPid: 999 }),
        scan,
        none,
        none,
      ),
    ).toBe("WS-DIR");
  });

  test("does NOT borrow a sibling's workspace id when the exact session lacks one", async () => {
    // Exact-id session has no workspace id; a sibling in the same cwd does. The
    // cwd scan must not fire on a positive-identity match — return the
    // spawn-registry ref for THIS session, never the sibling's live id.
    rememberCmuxWorkspace("/tmp", "OK workspace:5");
    const scan = async () => [
      portFile({ sessionId: "sid-1", cwd: "/tmp" }), // this session, no id
      portFile({ sessionId: "sib", cwd: "/tmp", cmuxWorkspaceId: "WS-SIB" }),
    ];
    expect(await resolveCmuxWorkspace(sctx({ sessionId: "sid-1" }), scan)).toBe(
      "workspace:5",
    );
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

  test("detects Cursor's integrated terminal from its pty-host ancestry", () => {
    // Observed ancestry: claude → bash → Cursor Helper: terminal pty-host → Cursor
    const tree: Record<number, ProcRow> = {
      10: { ppid: 9, comm: "claude" },
      9: { ppid: 8, comm: "/opt/homebrew/bin/bash" },
      8: {
        ppid: 7,
        comm: "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)",
      },
      7: { ppid: 1, comm: "/Applications/Cursor.app/Contents/MacOS/Cursor" },
    };
    expect(detectTerminalApp(10, (p) => tree[p] ?? null)).toBe("cursor");
  });

  test("prefers cmux over cursor when a session runs in cmux inside Cursor", () => {
    // cmux is matched before cursor, so a cmux host wins even under Cursor.
    const tree: Record<number, ProcRow> = {
      10: { ppid: 9, comm: "claude" },
      9: { ppid: 8, comm: "/Applications/cmux.app/Contents/MacOS/cmux" },
      8: { ppid: 1, comm: "/Applications/Cursor.app/Contents/MacOS/Cursor" },
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
