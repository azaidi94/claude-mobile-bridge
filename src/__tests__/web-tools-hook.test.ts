import { describe, expect, test, beforeAll } from "bun:test";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

// Set required env vars before importing session (which imports config)
beforeAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_ALLOWED_USERS = "123456789";
});

// Dynamic import to ensure env vars are set first
const getHook = async () => {
  const { autoApproveWebTools } = await import("../session");
  return autoApproveWebTools;
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
    const autoApproveWebTools = await getHook();
    const input = createMockInput("WebSearch");
    const result = await autoApproveWebTools(input, undefined, { signal: new AbortController().signal });

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Auto-approved for Telegram bot",
      },
    });
  });

  test("should auto-approve WebFetch", async () => {
    const autoApproveWebTools = await getHook();
    const input = createMockInput("WebFetch");
    const result = await autoApproveWebTools(input, undefined, { signal: new AbortController().signal });

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Auto-approved for Telegram bot",
      },
    });
  });

  test("should pass through Bash tool without modification", async () => {
    const autoApproveWebTools = await getHook();
    const input = createMockInput("Bash");
    const result = await autoApproveWebTools(input, undefined, { signal: new AbortController().signal });

    expect(result).toEqual({});
  });

  test("should pass through Read tool without modification", async () => {
    const autoApproveWebTools = await getHook();
    const input = createMockInput("Read");
    const result = await autoApproveWebTools(input, undefined, { signal: new AbortController().signal });

    expect(result).toEqual({});
  });

  test("should pass through Edit tool without modification", async () => {
    const autoApproveWebTools = await getHook();
    const input = createMockInput("Edit");
    const result = await autoApproveWebTools(input, undefined, { signal: new AbortController().signal });

    expect(result).toEqual({});
  });

  test("should pass through Write tool without modification", async () => {
    const autoApproveWebTools = await getHook();
    const input = createMockInput("Write");
    const result = await autoApproveWebTools(input, undefined, { signal: new AbortController().signal });

    expect(result).toEqual({});
  });
});
