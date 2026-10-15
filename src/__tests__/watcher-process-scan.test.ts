import { describe, test, expect } from "bun:test";
import {
  parseClaudeProcessList,
  parseSessionFile,
  sessionsFromPortFiles,
} from "../sessions/watcher";
import type { PortFileData } from "../relay/discovery";

const DESKTOP_CLAUDE =
  "/Users/ali/Library/Application Support/Claude/claude-code/2.1.299/4fa9694b7975/claude.app/Contents/MacOS/claude";

describe("parseClaudeProcessList", () => {
  // Regression: the desktop app's bundled CLI path holds a space, so the old
  // awk `$3` split saw "…/Application" and matched no desktop sessions at all.
  test("matches the desktop app's bundled claude (path with spaces)", () => {
    const ps = [
      `18054 18053 ${DESKTOP_CLAUDE}`,
      ` 9508  9507 ${DESKTOP_CLAUDE}`,
    ].join("\n");
    expect(parseClaudeProcessList(ps)).toEqual([
      { pid: 18054, ppid: 18053 },
      { pid: 9508, ppid: 9507 },
    ]);
  });

  test("matches CLI claude and version-named binaries", () => {
    const ps = [
      "  101   100 claude",
      "  201   200 /opt/homebrew/bin/claude",
      "  301   300 /Users/ali/.local/share/claude/versions/2.1.299",
    ].join("\n");
    expect(parseClaudeProcessList(ps).map((p) => p.pid)).toEqual([
      101, 201, 301,
    ]);
  });

  test("ignores the desktop app, its helpers and look-alikes", () => {
    const ps = [
      "74585     1 /Applications/Claude.app/Contents/MacOS/Claude",
      "18053 74585 /Applications/Claude.app/Contents/Helpers/disclaimer",
      "  555     1 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)",
      "  666     1 /usr/local/bin/claude-mobile-bridge",
      "  777     1 bun",
      "",
      "garbage line",
    ].join("\n");
    expect(parseClaudeProcessList(ps)).toEqual([]);
  });
});

describe("sessionsFromPortFiles (no-process fallback)", () => {
  const pf = (o: Partial<PortFileData>): PortFileData => ({
    port: 1,
    pid: 10,
    cwd: "/p",
    startedAt: "2026-10-15T13:05:43.633Z",
    ...o,
  });

  // Regression: this path used to hard-code id "" and drop the pid, so the
  // notifier never saw a sessionId and skipped every topic.
  test("keeps the port file's sessionId and Claude pid", () => {
    const [s] = sessionsFromPortFiles([pf({ sessionId: "sid-a", ppid: 99 })]);
    expect(s).toMatchObject({
      id: "sid-a",
      pid: 99,
      dir: "/p",
      source: "desktop",
      lastActivity: Date.parse("2026-10-15T13:05:43.633Z"),
    });
  });

  test("id-less port file → empty id, no pid key", () => {
    const [s] = sessionsFromPortFiles([pf({})]);
    expect(s!.id).toBe("");
    expect("pid" in s!).toBe(false);
  });
});

describe("parseSessionFile (head-only read)", () => {
  const { mkdtempSync, writeFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  const { tmpdir } = require("os") as typeof import("os");
  const dir = mkdtempSync(join(tmpdir(), "watcher-head-"));
  const line = (o: object) => JSON.stringify(o) + "\n";

  test("finds id + cwd in the opening lines of a huge transcript", async () => {
    const p = join(dir, "big.jsonl");
    writeFileSync(
      p,
      line({ sessionId: "sid-1", cwd: "/w" }) +
        line({ pad: "x".repeat(1024 * 1024) }),
    );
    expect(await parseSessionFile(p)).toEqual({
      sessionId: "sid-1",
      cwd: "/w",
    });
  });

  test("falls back to the whole file when the first line is oversized", async () => {
    const p = join(dir, "fat-first.jsonl");
    writeFileSync(
      p,
      line({ type: "queue-operation", content: "y".repeat(200 * 1024) }) +
        line({ sessionId: "sid-2", cwd: "/v" }),
    );
    expect(await parseSessionFile(p)).toEqual({
      sessionId: "sid-2",
      cwd: "/v",
    });
  });

  test("missing file → null", async () => {
    expect(await parseSessionFile(join(dir, "nope.jsonl"))).toBeNull();
  });
});
