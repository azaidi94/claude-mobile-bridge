import "./ensure-test-env";
import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";
import { existsSync } from "fs";

const HOOK = join(import.meta.dir, "../../hooks/claude-remote-auq-bridge.sh");

describe("AUQ-bridge hook script", () => {
  test("exists and is executable", () => {
    expect(existsSync(HOOK)).toBe(true);
  });

  test("returns allow JSON for non-AskUserQuestion tools (no-op fast path)", () => {
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "t1",
      session_id: "s1",
      cwd: "/tmp",
    });
    const r = spawnSync(HOOK, [], { input, timeout: 1000 });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.toString());
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput).toBeUndefined();
  });

  test("returns allow JSON for AskUserQuestion when bot unreachable", () => {
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: "Q", options: [{ label: "A" }, { label: "B" }] },
        ],
      },
      tool_use_id: "t2",
      session_id: "s2",
      cwd: "/tmp",
    });
    const r = spawnSync(HOOK, [], {
      input,
      timeout: 1000,
      env: { ...process.env, RELAY_AUQ_SECRET: "" },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.toString());
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("completes in <500ms", () => {
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {},
      tool_use_id: "t3",
      session_id: "s3",
      cwd: "/tmp",
    });
    const start = Date.now();
    spawnSync(HOOK, [], { input, timeout: 500 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});
