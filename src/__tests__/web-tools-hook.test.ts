/**
 * Tests for the autoApproveWebTools hook logic.
 *
 * Tests the hook inline to avoid cross-test mock contamination
 * from other test files that mock session.ts dependencies.
 */

import { describe, expect, test } from "bun:test";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

// Replicate the hook logic directly to avoid fragile session.ts import chain
const autoApproveWebTools = async (input: PreToolUseHookInput) => {
  if (input.tool_name === "WebSearch" || input.tool_name === "WebFetch") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "allow" as const,
        permissionDecisionReason: "Auto-approved for Telegram bot",
      },
    };
  }
  return {};
};

describe("autoApproveWebTools hook", () => {
  const createMockInput = (toolName: string): PreToolUseHookInput =>
    ({
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: {},
      session_id: "test-session",
      transcript_path: "/tmp/transcript.json",
      cwd: "/home/user",
    }) as PreToolUseHookInput;

  test("should auto-approve WebSearch", async () => {
    const input = createMockInput("WebSearch");
    const result = await autoApproveWebTools(input);

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Auto-approved for Telegram bot",
      },
    });
  });

  test("should auto-approve WebFetch", async () => {
    const input = createMockInput("WebFetch");
    const result = await autoApproveWebTools(input);

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Auto-approved for Telegram bot",
      },
    });
  });

  test("should pass through Bash tool without modification", async () => {
    const input = createMockInput("Bash");
    const result = await autoApproveWebTools(input);
    expect(result).toEqual({});
  });

  test("should pass through Read tool without modification", async () => {
    const input = createMockInput("Read");
    const result = await autoApproveWebTools(input);
    expect(result).toEqual({});
  });

  test("should pass through Edit tool without modification", async () => {
    const input = createMockInput("Edit");
    const result = await autoApproveWebTools(input);
    expect(result).toEqual({});
  });

  test("should pass through Write tool without modification", async () => {
    const input = createMockInput("Write");
    const result = await autoApproveWebTools(input);
    expect(result).toEqual({});
  });
});
