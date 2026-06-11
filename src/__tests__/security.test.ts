/**
 * Tests for checkCommandSafety (rm parsing fixes) and enforceToolSafety hook.
 *
 * Tests the hook inline to avoid cross-test mock contamination from session.ts
 * import chain (same pattern as web-tools-hook.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { checkCommandSafety } from "../security";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

// ============== checkCommandSafety ==============

describe("checkCommandSafety — rm dangerous paths", () => {
  test("blocks rm -fr /", () => {
    const [safe, reason] = checkCommandSafety("rm -fr /");
    expect(safe).toBe(false);
    expect(reason).toContain("rm target outside allowed paths");
  });

  test("blocks rm -r -f ~", () => {
    const [safe, reason] = checkCommandSafety("rm -r -f ~");
    expect(safe).toBe(false);
    expect(reason).toContain("rm target outside allowed paths");
  });

  test('blocks rm -rf "/"', () => {
    const [safe, reason] = checkCommandSafety('rm -rf "/"');
    expect(safe).toBe(false);
    expect(reason).toContain("rm target outside allowed paths");
  });

  test("blocks rm -rf $HOME (BLOCKED_PATTERNS)", () => {
    const [safe] = checkCommandSafety("rm -rf $HOME");
    expect(safe).toBe(false);
  });

  test("blocks piped: echo foo; rm -rf /", () => {
    const [safe] = checkCommandSafety("echo foo; rm -rf /");
    expect(safe).toBe(false);
  });
});

describe("checkCommandSafety — safe commands", () => {
  test("allows 'confirm delete' (rm not at word boundary)", () => {
    const [safe] = checkCommandSafety("confirm delete");
    expect(safe).toBe(true);
  });

  test("allows 'form a list' (contains rm sequence but not as command)", () => {
    const [safe] = checkCommandSafety("form a list");
    expect(safe).toBe(true);
  });

  test("allows rm of path within TEMP_PATHS (/tmp/...)", () => {
    const [safe] = checkCommandSafety("rm -rf /tmp/test-build");
    expect(safe).toBe(true);
  });

  test("allows rm of path within /private/tmp (macOS symlink target)", () => {
    const [safe] = checkCommandSafety("rm -rf /private/tmp/test-build");
    expect(safe).toBe(true);
  });
});

describe("checkCommandSafety — blocked-pattern word boundary", () => {
  // Shell word terminators after a /-or-~-ending pattern must count as a
  // boundary, not as "pattern is a prefix of a longer path". Tab is IFS
  // whitespace; | and > end the word just like ; and &.
  test("tab after 'rm -rf /' is a boundary — blocked at pattern level", () => {
    const [safe, reason] = checkCommandSafety("rm -rf /\t/tmp/safe");
    expect(safe).toBe(false);
    expect(reason).toContain("Blocked pattern");
  });

  test("pipe after 'rm -rf /' is a boundary — blocked at pattern level", () => {
    const [safe, reason] = checkCommandSafety("rm -rf /|true");
    expect(safe).toBe(false);
    expect(reason).toContain("Blocked pattern");
  });

  test("redirect after 'rm -rf /' is a boundary — blocked at pattern level", () => {
    const [safe, reason] = checkCommandSafety("rm -rf />/dev/null");
    expect(safe).toBe(false);
    expect(reason).toContain("Blocked pattern");
  });
});

// ============== enforceToolSafety hook (inlined to avoid session.ts import chain) ==============

import { checkCommandSafety as _checkSafety, isPathAllowed } from "../security";
import { TEMP_PATHS } from "../config";

const enforceToolSafetyInline = async (input: PreToolUseHookInput) => {
  const toolName = input.tool_name;
  const toolInput = input.tool_input as Record<string, unknown>;

  if (toolName === "Bash") {
    const command = String(toolInput.command || "");
    const [isSafe, reason] = _checkSafety(command);
    if (!isSafe) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: reason,
        },
      };
    }
  }

  if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
    const filePath = String(toolInput.file_path || "");
    if (filePath) {
      const isTmpRead =
        toolName === "Read" &&
        (TEMP_PATHS.some((p) => filePath.startsWith(p)) ||
          filePath.includes("/.claude/"));

      if (!isTmpRead && !isPathAllowed(filePath)) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: `File access blocked: ${filePath}`,
          },
        };
      }
    }
  }

  return {};
};

function makeBashInput(command: string): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "test-id",
    session_id: "test-session",
    transcript_path: "/tmp/transcript.json",
    cwd: "/tmp",
  } as PreToolUseHookInput;
}

function makeFileInput(
  toolName: string,
  filePath: string,
): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: { file_path: filePath },
    tool_use_id: "test-id",
    session_id: "test-session",
    transcript_path: "/tmp/transcript.json",
    cwd: "/tmp",
  } as PreToolUseHookInput;
}

describe("enforceToolSafety hook — deny paths", () => {
  test("denies Bash with rm -rf /", async () => {
    const result = await enforceToolSafetyInline(makeBashInput("rm -rf /"));
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("denies Bash with rm -fr /", async () => {
    const result = await enforceToolSafetyInline(makeBashInput("rm -fr /"));
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("denies Write to /etc/passwd", async () => {
    const result = await enforceToolSafetyInline(
      makeFileInput("Write", "/etc/passwd"),
    );
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain(
      "File access blocked",
    );
  });

  test("denies Edit to /etc/hosts", async () => {
    const result = await enforceToolSafetyInline(
      makeFileInput("Edit", "/etc/hosts"),
    );
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

describe("enforceToolSafety hook — allow paths", () => {
  test("allows Bash with safe command", async () => {
    const result = await enforceToolSafetyInline(makeBashInput("ls -la"));
    expect(result).toEqual({});
  });

  test("allows Bash: confirm delete (not an rm command)", async () => {
    const result = await enforceToolSafetyInline(
      makeBashInput("confirm delete"),
    );
    expect(result).toEqual({});
  });

  test("allows Read from /tmp (TEMP_PATHS exemption)", async () => {
    const result = await enforceToolSafetyInline(
      makeFileInput("Read", "/tmp/some-file.txt"),
    );
    expect(result).toEqual({});
  });

  test("allows Read from ~/.claude (temp read exemption)", async () => {
    const home = process.env.HOME ?? "/home/user";
    const result = await enforceToolSafetyInline(
      makeFileInput("Read", `${home}/.claude/settings.json`),
    );
    expect(result).toEqual({});
  });

  test("allows non-Bash tool without file_path (no-op)", async () => {
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "TodoWrite",
      tool_input: { todos: [] },
      tool_use_id: "test-id",
      session_id: "test-session",
      transcript_path: "/tmp/transcript.json",
      cwd: "/tmp",
    } as PreToolUseHookInput;
    const result = await enforceToolSafetyInline(input);
    expect(result).toEqual({});
  });
});
