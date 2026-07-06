import { describe, test, expect } from "bun:test";
import { decideOutcome } from "../../hooks/claude-remote-session-id";

describe("decideOutcome", () => {
  test("unparseable stdin → bail_bad_stdin", () => {
    expect(decideOutcome({ parsed: false, candidateCount: 0 })).toBe(
      "bail_bad_stdin",
    );
  });
  test("missing sessionId/cwd → bail_missing_fields", () => {
    expect(decideOutcome({ parsed: true, cwd: "/p", candidateCount: 1 })).toBe(
      "bail_missing_fields",
    );
    expect(
      decideOutcome({ parsed: true, sessionId: "s", candidateCount: 1 }),
    ).toBe("bail_missing_fields");
  });
  test("no port files → bail_no_port_files", () => {
    expect(
      decideOutcome({
        parsed: true,
        sessionId: "s",
        cwd: "/p",
        candidateCount: 0,
      }),
    ).toBe("bail_no_port_files");
  });
  test("no ancestry-matched target → bail_no_ancestry_match", () => {
    expect(
      decideOutcome({
        parsed: true,
        sessionId: "s",
        cwd: "/p",
        candidateCount: 3,
      }),
    ).toBe("bail_no_ancestry_match");
  });
  test("target already has this sessionId → noop_already_current", () => {
    const target = { file: "/x", cwd: "/p", ppid: 1 };
    expect(
      decideOutcome({
        parsed: true,
        sessionId: "s",
        cwd: "/p",
        candidateCount: 3,
        target,
        currentSessionId: "s",
      }),
    ).toBe("noop_already_current");
  });
  test("target with a different/absent id → updated", () => {
    const target = { file: "/x", cwd: "/p", ppid: 1 };
    expect(
      decideOutcome({
        parsed: true,
        sessionId: "s",
        cwd: "/p",
        candidateCount: 3,
        target,
        currentSessionId: "old",
      }),
    ).toBe("updated");
  });
});

import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

test("hook logs a bail reason for a non-ancestry cwd (integration)", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "sidhook-"));
  const logFile = join(logDir, "hook.log");
  const stateDir = mkdtempSync(join(tmpdir(), "sidhook-state-"));
  const proc = Bun.spawn(
    [
      "bun",
      join(import.meta.dir, "..", "..", "hooks", "claude-remote-session-id.ts"),
    ],
    {
      stdin: Buffer.from(
        JSON.stringify({
          session_id: "x",
          cwd: "/no/such/ancestry/cwd",
          source: "startup",
        }),
      ),
      env: {
        ...process.env,
        CLAUDE_SESSION_ID_HOOK_LOG: logFile,
        CLAUDE_TELEGRAM_STATE_DIR: stateDir, // empty → bail_no_port_files
      },
    },
  );
  const code = await proc.exited;
  expect(code).toBe(0); // hook always exits 0
  expect(existsSync(logFile)).toBe(true);
  const log = readFileSync(logFile, "utf-8");
  expect(log).toContain("bail reason=bail_no_port_files");
});
