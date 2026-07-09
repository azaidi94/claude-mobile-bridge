import { test, expect, describe } from "bun:test";
import {
  parseTmuxPanes,
  buildTmuxRows,
  captureArgs,
  killArgs,
  listPanesArgs,
  fitEscapedCapture,
  isNoServer,
  rowLabel,
  truncLabel,
  renderPanelBody,
  renderPanelKeyboard,
  type PaneInfo,
} from "../handlers/commands/tmux";
import type { PortFileData } from "../relay";

const pf = (o: Partial<PortFileData>): PortFileData => ({
  port: 1,
  pid: 10,
  ppid: 100,
  cwd: "/repo/kinetix",
  startedAt: "t",
  ...o,
});

describe("parseTmuxPanes", () => {
  // Format is `#{pane_id},#{session_attached},#{session_name}` — comma, not tab
  // (tmux rewrites a literal tab to `_` when the format has #{} expansions).
  test("parses pane/attached/session, treating 0 as detached", () => {
    const out = parseTmuxPanes("%1,1,cc-a-1\n%2,0,cc-b-2\n\n%3,2,cc-c-3\n");
    expect(out).toEqual([
      { pane: "%1", session: "cc-a-1", attached: true },
      { pane: "%2", session: "cc-b-2", attached: false },
      { pane: "%3", session: "cc-c-3", attached: true },
    ]);
  });

  test("a comma inside the session name survives (name is last, re-joined)", () => {
    expect(parseTmuxPanes("%1,1,my,weird,name")).toEqual([
      { pane: "%1", session: "my,weird,name", attached: true },
    ]);
  });

  test("skips malformed lines", () => {
    expect(parseTmuxPanes("garbage\n%1,0,cc")).toEqual([
      { pane: "%1", session: "cc", attached: false },
    ]);
  });

  test("REGRESSION: tab-mangled output (tmux rewrites tab→_) yields nothing, not a bogus row", () => {
    // What tmux actually emitted before the fix. Must not parse as a pane.
    expect(parseTmuxPanes("%0_cc-repo-abc-123_1\n")).toEqual([]);
  });
});

describe("buildTmuxRows", () => {
  const panes = new Map<string, PaneInfo>([
    ["%1", { pane: "%1", session: "cc-kinetix-1", attached: true }],
    ["%2", { pane: "%2", session: "cc-saas-2", attached: false }],
  ]);
  const uuidByPid = new Map<number, string>([
    [100, "u-kinetix"],
    [200, "u-saas"],
  ]);
  const topicFor = (u: string) =>
    u === "u-kinetix"
      ? { topicId: 555, name: "kinetix-agents" }
      : u === "u-saas"
        ? { topicId: 777, name: "saas-builder" }
        : undefined;

  test("joins pane + launchUuid + topic id AND name for tmux sessions", () => {
    const rows = buildTmuxRows(
      [
        pf({ ppid: 100, tmuxPane: "%1", cwd: "/repo/kinetix" }),
        pf({ ppid: 200, tmuxPane: "%2", cwd: "/repo/saas" }),
      ],
      panes,
      uuidByPid,
      topicFor,
    );
    expect(rows).toEqual([
      {
        launchUuid: "u-kinetix",
        tmuxSession: "cc-kinetix-1",
        pane: "%1",
        cwd: "/repo/kinetix",
        attached: true,
        topicId: 555,
        topicName: "kinetix-agents",
      },
      {
        launchUuid: "u-saas",
        tmuxSession: "cc-saas-2",
        pane: "%2",
        cwd: "/repo/saas",
        attached: false,
        topicId: 777,
        topicName: "saas-builder",
      },
    ]);
  });

  test("skips port files without a tmux pane", () => {
    const rows = buildTmuxRows(
      [pf({ tmuxPane: undefined })],
      panes,
      uuidByPid,
      topicFor,
    );
    expect(rows).toEqual([]);
  });

  test("skips a port file whose pane is gone from tmux (stale)", () => {
    const rows = buildTmuxRows(
      [pf({ ppid: 100, tmuxPane: "%99" })],
      panes,
      uuidByPid,
      topicFor,
    );
    expect(rows).toEqual([]);
  });

  test("lists a non-hook session (no launchUuid) with topic undefined", () => {
    const rows = buildTmuxRows(
      [pf({ ppid: 999, tmuxPane: "%1" })],
      panes,
      uuidByPid,
      topicFor,
    );
    expect(rows[0]!.launchUuid).toBeUndefined();
    expect(rows[0]!.topicId).toBeUndefined();
    expect(rows[0]!.tmuxSession).toBe("cc-kinetix-1");
  });
});

describe("arg builders", () => {
  test("list-panes format is comma-delimited with the session name last (never a tab)", () => {
    const fmt = listPanesArgs().at(-1)!;
    expect(fmt).toBe("#{pane_id},#{session_attached},#{session_name}");
    expect(fmt).not.toContain("\t"); // tmux would rewrite it to `_`
  });

  test("all target the -L claude socket", () => {
    expect(listPanesArgs().slice(0, 3)).toEqual(["tmux", "-L", "claude"]);
    expect(captureArgs("%3")).toEqual([
      "tmux",
      "-L",
      "claude",
      "capture-pane",
      "-p",
      "-t",
      "%3",
    ]);
    expect(killArgs("cc-x-1")).toEqual([
      "tmux",
      "-L",
      "claude",
      "kill-session",
      "-t",
      "cc-x-1",
    ]);
  });
});

describe("isNoServer", () => {
  test("a killed/absent tmux server is 'zero sessions', not a failure", () => {
    expect(
      isNoServer("no server running on /private/tmp/tmux-501/claude"),
    ).toBe(true);
    expect(
      isNoServer("error connecting to /tmp/tmux-501/claude (No such file)"),
    ).toBe(true);
  });

  test("a genuine failure (tmux missing, permissions) is NOT 'no server'", () => {
    expect(isNoServer("tmux not runnable: ENOENT")).toBe(false);
    // The ENOENT wrapper can quote "no such file or directory" — must NOT be
    // mistaken for an empty tmux server (that's the bug this guard prevents).
    expect(
      isNoServer("tmux not runnable: ENOENT: no such file or directory"),
    ).toBe(false);
    expect(isNoServer("permission denied")).toBe(false);
    expect(isNoServer("")).toBe(false);
  });
});

describe("fitEscapedCapture", () => {
  test("HTML-escapes and strips trailing blanks", () => {
    expect(fitEscapedCapture("a<b> & c\n\n")).toBe("a&lt;b&gt; &amp; c");
  });

  test("bounds the ESCAPED length (escaping happens before the cap)", () => {
    // 2000 '<' chars → 2000*4 = 8000 escaped, well over a small cap.
    const raw = "<".repeat(2000);
    const out = fitEscapedCapture(raw, 400);
    expect(out.length).toBeLessThanOrEqual("…\n".length + 400);
    // Never ends mid-entity — the tail is whole &lt; tokens.
    expect(out.endsWith("&lt;")).toBe(true);
  });

  test("keeps the BOTTOM (most recent) lines with a marker", () => {
    const long = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
    const out = fitEscapedCapture(long, 40);
    expect(out.startsWith("…\n")).toBe(true);
    expect(out.endsWith("line99")).toBe(true);
  });
});

describe("rowLabel", () => {
  const base = {
    launchUuid: "6ce10182-aaaa",
    tmuxSession: "cc-kinetix-agents-095bbde0-61530",
    pane: "%1",
    cwd: "/repo/kinetix-agents",
    attached: true,
  };

  test("prefers the Telegram topic name", () => {
    expect(rowLabel({ ...base, topicName: "kinetix-agents-2" })).toBe(
      "kinetix-agents-2",
    );
  });

  test("no topic → <dir>-<pid>, which disambiguates same-folder siblings", () => {
    expect(rowLabel(base)).toBe("kinetix-agents-61530");
    expect(
      rowLabel({ ...base, tmuxSession: "cc-kinetix-agents-095bbde0-61135" }),
    ).toBe("kinetix-agents-61135");
  });

  test("falls back to the short launchUuid when there's no numeric pid suffix", () => {
    expect(rowLabel({ ...base, tmuxSession: "weird-name" })).toBe("6ce10182");
  });

  test("truncLabel keeps buttons phone-readable", () => {
    expect(truncLabel("short")).toBe("short");
    expect(truncLabel("a".repeat(30)).length).toBe(20);
    expect(truncLabel("a".repeat(30)).endsWith("…")).toBe(true);
  });
});

describe("rendering", () => {
  const rows = [
    {
      launchUuid: "u-kinetix",
      tmuxSession: "cc-kinetix-1",
      pane: "%1",
      cwd: "/repo/kinetix",
      attached: true,
      topicId: 555,
      topicName: "kinetix-agents",
    },
    {
      launchUuid: "u-kinetix-2",
      tmuxSession: "cc-kinetix-2",
      pane: "%2",
      cwd: "/repo/kinetix",
      attached: false,
      topicId: 556,
      topicName: "kinetix-agents-2",
    },
  ];

  test("empty panel", () => {
    expect(renderPanelBody([])).toContain(
      "No Claude sessions running under tmux",
    );
  });

  test("body leads with the numbered topic name, keeps the tmux session as detail", () => {
    const body = renderPanelBody(rows);
    expect(body).toContain("<b>1. kinetix-agents</b>");
    expect(body).toContain("<b>2. kinetix-agents-2</b>");
    expect(body).toContain("cc-kinetix-1"); // still shown, secondary
  });

  test("a row with no topic is marked, and labelled by dir-pid", () => {
    const body = renderPanelBody([
      { ...rows[0]!, topicName: undefined, tmuxSession: "cc-kinetix-99" },
    ]);
    expect(body).toContain("(no topic)");
    expect(body).toContain("1. kinetix-99");
  });

  test("buttons carry the row NUMBER + name so each maps to its row", () => {
    const kb = renderPanelKeyboard(rows);
    const btns = kb.inline_keyboard.flat() as any[];
    const texts = btns.map((b) => b.text);
    expect(texts).toContain("🔍 1. kinetix-agents");
    expect(texts).toContain("🔍 2. kinetix-agents-2");
    expect(texts).toContain("💀 1");
    expect(texts).toContain("💀 2");
    const data = btns.map((b) => b.callback_data);
    expect(data).toContain("tmux:peek:u-kinetix");
    expect(data).toContain("tmux:kill:u-kinetix-2");
    expect(data).toContain("tmux:start");
  });

  test("a non-hook row (no launchUuid) gets no action buttons", () => {
    const kb = renderPanelKeyboard([{ ...rows[0]!, launchUuid: undefined }]);
    const data = kb.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(data).toEqual(["tmux:start"]); // only the footer
  });
});
