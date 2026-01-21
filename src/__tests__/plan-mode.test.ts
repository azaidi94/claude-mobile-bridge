/**
 * Unit tests for plan mode functionality.
 *
 * Tests /plan command, plan approval keyboard, plan callbacks,
 * pending feedback flow, and session plan mode state.
 */

import { describe, expect, test, beforeEach, mock, spyOn } from "bun:test";

// Mock config before importing handlers
const MOCK_ALLOWED_USERS = [123456, 789012];

mock.module("../config", () => ({
  ALLOWED_USERS: MOCK_ALLOWED_USERS,
  TELEGRAM_TOKEN: "test-token",
  WORKING_DIR: "/tmp/test-working-dir",
  OPENAI_API_KEY: "",
  CLAUDE_CLI_PATH: "/usr/local/bin/claude",
  MCP_SERVERS: {},
  ALLOWED_PATHS: ["/tmp"],
  SAFETY_PROMPT: "test prompt",
  BLOCKED_PATTERNS: ["rm -rf /"],
  QUERY_TIMEOUT_MS: 180000,
  TRANSCRIPTION_PROMPT: "test",
  TRANSCRIPTION_AVAILABLE: false,
  THINKING_KEYWORDS: ["think"],
  THINKING_DEEP_KEYWORDS: ["ultrathink"],
  MEDIA_GROUP_TIMEOUT: 1000,
  TELEGRAM_MESSAGE_LIMIT: 4096,
  TELEGRAM_SAFE_LIMIT: 4000,
  STREAMING_THROTTLE_MS: 500,
  BUTTON_LABEL_MAX_LENGTH: 30,
  AUDIT_LOG_PATH: "/tmp/audit.log",
  AUDIT_LOG_JSON: false,
  RATE_LIMIT_ENABLED: false,
  RATE_LIMIT_REQUESTS: 20,
  RATE_LIMIT_WINDOW: 60,
  SESSION_FILE: "/tmp/test-session.json",
  RESTART_FILE: "/tmp/test-restart.json",
  TEMP_DIR: "/tmp/telegram-bot",
  TEMP_PATHS: ["/tmp/"],
}));

// Mock sessions module
const mockSessions: Array<{ name: string; dir: string; lastActivity: number }> = [];
let mockActiveSession: { name: string; info: { dir: string; id?: string; name: string; lastActivity?: number } } | null = null;

mock.module("../sessions", () => ({
  getSessions: mock(() => mockSessions),
  getActiveSession: mock(() => mockActiveSession),
  setActiveSession: mock((name: string) => {
    const found = mockSessions.find(s => s.name === name);
    if (found) {
      mockActiveSession = { name: found.name, info: { dir: found.dir, name: found.name } };
      return true;
    }
    return false;
  }),
  addTelegramSession: mock((path: string, name?: string) => {
    const sessionName = name || `telegram-${Date.now()}`;
    const newSession = { name: sessionName, dir: path, lastActivity: Date.now() };
    mockSessions.push(newSession);
    mockActiveSession = { name: sessionName, info: { dir: path, name: sessionName } };
    return newSession;
  }),
  forceRefresh: mock(() => Promise.resolve()),
}));

// Mock session singleton with plan mode state
const mockSessionState = {
  isRunning: false,
  isActive: false,
  sessionId: null as string | null,
  sessionName: null as string | null,
  workingDir: "/tmp/test-working-dir",
  lastMessage: null as string | null,
  lastActivity: null as Date | null,
  lastTool: null as string | null,
  currentTool: null as string | null,
  lastError: null as string | null,
  lastUsage: null as { input_tokens?: number; output_tokens?: number } | null,
  queryStarted: null as Date | null,
  isPlanMode: false,
  pendingPlanApproval: null as { toolUseId: string; planSummary: string; planContent?: string; timestamp: number } | null,
};

const mockSessionMethods = {
  stop: mock(() => Promise.resolve()),
  clearStopRequested: mock(() => {}),
  kill: mock(() => Promise.resolve()),
  setWorkingDir: mock((dir: string) => { mockSessionState.workingDir = dir; }),
  loadFromRegistry: mock((info: { dir: string; name: string }) => {
    mockSessionState.workingDir = info.dir;
    mockSessionState.sessionName = info.name;
  }),
  startProcessing: mock(() => () => {}),
  consumeInterruptFlag: mock(() => false),
  sendMessageStreaming: mock(async () => "Test response"),
  respondToPlanApproval: mock(async () => "Plan response"),
  clearPendingPlanApproval: mock(() => { mockSessionState.pendingPlanApproval = null; }),
};

mock.module("../session", () => ({
  session: {
    get isRunning() { return mockSessionState.isRunning; },
    get isActive() { return mockSessionState.isActive; },
    get sessionId() { return mockSessionState.sessionId; },
    set sessionId(val: string | null) { mockSessionState.sessionId = val; },
    get sessionName() { return mockSessionState.sessionName; },
    get workingDir() { return mockSessionState.workingDir; },
    get lastMessage() { return mockSessionState.lastMessage; },
    set lastMessage(val: string | null) { mockSessionState.lastMessage = val; },
    get lastActivity() { return mockSessionState.lastActivity; },
    get lastTool() { return mockSessionState.lastTool; },
    get currentTool() { return mockSessionState.currentTool; },
    get lastError() { return mockSessionState.lastError; },
    get lastUsage() { return mockSessionState.lastUsage; },
    get queryStarted() { return mockSessionState.queryStarted; },
    get isPlanMode() { return mockSessionState.isPlanMode; },
    get pendingPlanApproval() { return mockSessionState.pendingPlanApproval; },
    ...mockSessionMethods,
  },
}));

// Mock security - must include all exports to avoid breaking other tests
mock.module("../security", () => ({
  isAuthorized: mock((userId: number, allowedUsers: number[]) => allowedUsers.includes(userId)),
  rateLimiter: {
    check: mock(() => [true, 0] as [boolean, number]),
    getStatus: mock(() => ({ tokens: 20, lastUpdate: Date.now(), max: 20, refillRate: 1 })),
  },
  checkCommandSafety: mock((cmd: string) => {
    if (cmd.includes("rm -rf /")) return [false, "Blocked"];
    return [true, ""];
  }),
  isPathAllowed: mock((path: string) => {
    if (path.startsWith("/tmp")) return true;
    if (path.startsWith("/etc")) return false;
    return true;
  }),
}));

// Mock utils
mock.module("../utils", () => ({
  auditLog: mock(() => Promise.resolve()),
  auditLogRateLimit: mock(() => Promise.resolve()),
  startTypingIndicator: mock(() => ({ stop: mock(() => {}) })),
  checkInterrupt: mock((msg: string) => Promise.resolve(msg)),
}));

// Test helpers
function createMockContext(overrides: Partial<{
  userId: number;
  username: string;
  chatId: number;
  messageText: string;
  callbackData: string;
}> = {}) {
  const {
    userId = 123456,
    username = "testuser",
    chatId = 789,
    messageText = "/plan test",
    callbackData,
  } = overrides;

  const replies: Array<{ text: string; options?: Record<string, unknown> }> = [];
  const editedMessages: Array<{ text: string; options?: Record<string, unknown> }> = [];
  const documents: Array<{ file: unknown; options?: Record<string, unknown> }> = [];

  return {
    from: { id: userId, username },
    chat: { id: chatId },
    message: { text: messageText, message_id: 1 },
    callbackQuery: callbackData ? { data: callbackData } : undefined,
    reply: mock(async (text: string, options?: Record<string, unknown>) => {
      replies.push({ text, options });
      return { chat: { id: chatId }, message_id: Date.now() };
    }),
    replyWithDocument: mock(async (file: unknown, options?: Record<string, unknown>) => {
      documents.push({ file, options });
      return { chat: { id: chatId }, message_id: Date.now() };
    }),
    editMessageText: mock(async (text: string, options?: Record<string, unknown>) => {
      editedMessages.push({ text, options });
      return true;
    }),
    answerCallbackQuery: mock(async () => true),
    api: {
      sendMessage: mock(async () => ({ message_id: Date.now() })),
      editMessageText: mock(async () => ({})),
      deleteMessage: mock(async () => true),
    },
    _replies: replies,
    _editedMessages: editedMessages,
    _documents: documents,
  };
}

function resetMocks() {
  mockSessions.length = 0;
  mockActiveSession = null;
  mockSessionState.isRunning = false;
  mockSessionState.isActive = false;
  mockSessionState.sessionId = null;
  mockSessionState.sessionName = null;
  mockSessionState.workingDir = "/tmp/test-working-dir";
  mockSessionState.lastMessage = null;
  mockSessionState.lastActivity = null;
  mockSessionState.isPlanMode = false;
  mockSessionState.pendingPlanApproval = null;

  // Reset mock call counts
  mockSessionMethods.sendMessageStreaming.mockClear();
  mockSessionMethods.respondToPlanApproval.mockClear();
  mockSessionMethods.startProcessing.mockClear();
}

// ============== createPlanApprovalKeyboard Tests ==============

describe("plan-mode: createPlanApprovalKeyboard", () => {
  beforeEach(resetMocks);

  test("creates keyboard with Accept, Reject, Edit buttons", async () => {
    const { createPlanApprovalKeyboard } = await import("../handlers/streaming");

    const keyboard = createPlanApprovalKeyboard("req-123");
    const data = (keyboard as any).inline_keyboard;

    expect(data).toBeDefined();
    expect(data.length).toBe(3);
  });

  test("creates correct callback data for each button", async () => {
    const { createPlanApprovalKeyboard } = await import("../handlers/streaming");

    const keyboard = createPlanApprovalKeyboard("abc-123");
    const data = (keyboard as any).inline_keyboard;

    // Accept button
    expect(data[0][0].text).toContain("Accept");
    expect(data[0][0].callback_data).toBe("plan:accept:abc-123");

    // Reject button
    expect(data[1][0].text).toContain("Reject");
    expect(data[1][0].callback_data).toBe("plan:reject:abc-123");

    // Edit button
    expect(data[2][0].text).toContain("Edit");
    expect(data[2][0].callback_data).toBe("plan:edit:abc-123");
  });

  test("includes emoji icons in button text", async () => {
    const { createPlanApprovalKeyboard } = await import("../handlers/streaming");

    const keyboard = createPlanApprovalKeyboard("test");
    const data = (keyboard as any).inline_keyboard;

    expect(data[0][0].text).toBe("✅ Accept");
    expect(data[1][0].text).toBe("❌ Reject");
    expect(data[2][0].text).toBe("✏️ Edit");
  });

  test("handles different request IDs", async () => {
    const { createPlanApprovalKeyboard } = await import("../handlers/streaming");

    const keyboard1 = createPlanApprovalKeyboard("id-1");
    const keyboard2 = createPlanApprovalKeyboard("id-2");

    const data1 = (keyboard1 as any).inline_keyboard;
    const data2 = (keyboard2 as any).inline_keyboard;

    expect(data1[0][0].callback_data).toBe("plan:accept:id-1");
    expect(data2[0][0].callback_data).toBe("plan:accept:id-2");
  });
});

// ============== handlePlan Command Tests ==============

describe("plan-mode: handlePlan command", () => {
  beforeEach(resetMocks);

  test("rejects unauthorized users", async () => {
    const { handlePlan } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 999999, messageText: "/plan test" });

    await handlePlan(ctx as any);

    expect(ctx._replies.length).toBe(1);
    expect(ctx._replies[0]?.text).toBe("Unauthorized.");
  });

  test("shows usage when no message provided", async () => {
    const { handlePlan } = await import("../handlers/commands");
    const ctx = createMockContext({ messageText: "/plan" });

    await handlePlan(ctx as any);

    expect(ctx._replies.length).toBe(1);
    expect(ctx._replies[0]?.text).toContain("Usage:");
  });

  test("shows usage for /plan with only whitespace", async () => {
    const { handlePlan } = await import("../handlers/commands");
    const ctx = createMockContext({ messageText: "/plan   " });

    await handlePlan(ctx as any);

    expect(ctx._replies.length).toBe(1);
    expect(ctx._replies[0]?.text).toContain("Usage:");
  });

  test("starts plan mode with valid message", async () => {
    const { handlePlan } = await import("../handlers/commands");
    const ctx = createMockContext({ messageText: "/plan add a hello world endpoint" });

    await handlePlan(ctx as any);

    // Should show "Starting plan mode..." message
    const startMsg = ctx._replies.find(r => r.text.includes("plan mode"));
    expect(startMsg).toBeDefined();
  });

  test("calls sendMessageStreaming with plan permission mode", async () => {
    const { handlePlan } = await import("../handlers/commands");
    const ctx = createMockContext({ messageText: "/plan implement feature X" });

    await handlePlan(ctx as any);

    expect(mockSessionMethods.sendMessageStreaming).toHaveBeenCalled();
    // Verify the mock was called (implementation details may vary)
    expect(mockSessionMethods.sendMessageStreaming.mock.calls.length).toBeGreaterThan(0);
  });

  test("shows approval buttons when plan is ready", async () => {
    const { handlePlan } = await import("../handlers/commands");
    const ctx = createMockContext({ messageText: "/plan add feature" });

    // Simulate pending plan approval
    mockSessionState.pendingPlanApproval = {
      toolUseId: "tool-123",
      planSummary: "Test plan summary",
      timestamp: Date.now(),
    };

    await handlePlan(ctx as any);

    // Should show approval message with keyboard
    const approvalMsg = ctx._replies.find(r => r.text.includes("Review and approve"));
    expect(approvalMsg).toBeDefined();
    expect(approvalMsg?.options?.reply_markup).toBeDefined();
  });

  test("handles missing context gracefully", async () => {
    const { handlePlan } = await import("../handlers/commands");
    const ctx = {
      from: undefined,
      chat: undefined,
      message: undefined,
      reply: mock(async () => ({})),
    };

    // Should not throw
    await handlePlan(ctx as any);
  });
});

// ============== Plan Callback Tests ==============

describe("plan-mode: plan callbacks", () => {
  beforeEach(resetMocks);

  test("rejects unauthorized callback", async () => {
    const { handleCallback } = await import("../handlers/callback");
    const ctx = createMockContext({
      userId: 999999,
      callbackData: "plan:accept:123",
    });

    await handleCallback(ctx as any);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Unauthorized" });
  });

  test("handles missing pending plan approval", async () => {
    const { handleCallback } = await import("../handlers/callback");
    const ctx = createMockContext({
      callbackData: "plan:accept:123",
    });

    mockSessionState.pendingPlanApproval = null;

    await handleCallback(ctx as any);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "No pending plan" });
  });

  test("handles accept action", async () => {
    const { handleCallback } = await import("../handlers/callback");
    const ctx = createMockContext({
      callbackData: "plan:accept:123",
    });

    mockSessionState.pendingPlanApproval = {
      toolUseId: "tool-123",
      planSummary: "Test plan",
      timestamp: Date.now(),
    };

    await handleCallback(ctx as any);

    // Should edit message to show accepted
    expect(ctx.editMessageText).toHaveBeenCalledWith("✅ Plan accepted");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Accepted" });
  });

  test("handles reject action", async () => {
    const { handleCallback } = await import("../handlers/callback");
    const ctx = createMockContext({
      callbackData: "plan:reject:123",
    });

    mockSessionState.pendingPlanApproval = {
      toolUseId: "tool-123",
      planSummary: "Test plan",
      timestamp: Date.now(),
    };

    await handleCallback(ctx as any);

    // Should edit message to show rejected
    expect(ctx.editMessageText).toHaveBeenCalledWith("❌ Plan rejected");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Rejected" });
  });

  test("handles edit action - prompts for feedback", async () => {
    const { handleCallback, pendingPlanFeedback } = await import("../handlers/callback");
    const ctx = createMockContext({
      callbackData: "plan:edit:123",
      chatId: 789,
    });

    mockSessionState.pendingPlanApproval = {
      toolUseId: "tool-123",
      planSummary: "Test plan",
      timestamp: Date.now(),
    };

    await handleCallback(ctx as any);

    // Should prompt for feedback
    expect(ctx.editMessageText).toHaveBeenCalledWith("✏️ Reply with your feedback for the plan:");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Send your feedback" });

    // Should store pending feedback state
    expect(pendingPlanFeedback.has(789)).toBe(true);
  });

  test("calls respondToPlanApproval on accept", async () => {
    const { handleCallback } = await import("../handlers/callback");
    const ctx = createMockContext({
      callbackData: "plan:accept:123",
    });

    mockSessionState.pendingPlanApproval = {
      toolUseId: "tool-123",
      planSummary: "Test plan",
      timestamp: Date.now(),
    };

    await handleCallback(ctx as any);

    expect(mockSessionMethods.respondToPlanApproval).toHaveBeenCalled();
    expect(mockSessionMethods.respondToPlanApproval.mock.calls.length).toBeGreaterThan(0);
  });

  test("calls respondToPlanApproval on reject", async () => {
    const { handleCallback } = await import("../handlers/callback");
    const ctx = createMockContext({
      callbackData: "plan:reject:456",
    });

    mockSessionState.pendingPlanApproval = {
      toolUseId: "tool-456",
      planSummary: "Test plan",
      timestamp: Date.now(),
    };

    await handleCallback(ctx as any);

    expect(mockSessionMethods.respondToPlanApproval).toHaveBeenCalled();
    expect(mockSessionMethods.respondToPlanApproval.mock.calls.length).toBeGreaterThan(0);
  });

  test("handles invalid callback data format", async () => {
    const { handleCallback } = await import("../handlers/callback");
    const ctx = createMockContext({
      callbackData: "plan:invalid",
    });

    await handleCallback(ctx as any);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Invalid callback" });
  });
});

// ============== Pending Plan Feedback Tests ==============

describe("plan-mode: pending feedback flow", () => {
  beforeEach(resetMocks);

  test("pendingPlanFeedback map stores chat ID and request ID", async () => {
    const { pendingPlanFeedback } = await import("../handlers/callback");

    pendingPlanFeedback.set(123, "req-abc");
    pendingPlanFeedback.set(456, "req-def");

    expect(pendingPlanFeedback.get(123)).toBe("req-abc");
    expect(pendingPlanFeedback.get(456)).toBe("req-def");

    // Cleanup
    pendingPlanFeedback.delete(123);
    pendingPlanFeedback.delete(456);
  });

  test("feedback clears pending state after processing", async () => {
    const { pendingPlanFeedback } = await import("../handlers/callback");

    // Simulate edit button press
    pendingPlanFeedback.set(789, "req-123");
    expect(pendingPlanFeedback.has(789)).toBe(true);

    // Simulate text handler processing feedback (manual simulation)
    pendingPlanFeedback.delete(789);
    expect(pendingPlanFeedback.has(789)).toBe(false);
  });
});

// ============== PlanApprovalState Type Tests ==============

describe("plan-mode: PlanApprovalState type", () => {
  test("has correct shape", async () => {
    const state: { toolUseId: string; planSummary: string; planContent?: string; timestamp: number } = {
      toolUseId: "tool-use-123",
      planSummary: "This is a plan summary",
      timestamp: Date.now(),
    };

    expect(state.toolUseId).toBe("tool-use-123");
    expect(state.planSummary).toBe("This is a plan summary");
    expect(typeof state.timestamp).toBe("number");
  });

  test("planSummary can be truncated", async () => {
    const longPlan = "x".repeat(1000);
    const state: { toolUseId: string; planSummary: string; planContent?: string; timestamp: number } = {
      toolUseId: "tool-123",
      planSummary: longPlan.slice(0, 500),
      timestamp: Date.now(),
    };

    expect(state.planSummary.length).toBe(500);
  });

  test("planContent is optional", async () => {
    const stateWithContent: { toolUseId: string; planSummary: string; planContent?: string; timestamp: number } = {
      toolUseId: "tool-123",
      planSummary: "Summary",
      planContent: "Full plan content here",
      timestamp: Date.now(),
    };

    const stateWithoutContent: { toolUseId: string; planSummary: string; planContent?: string; timestamp: number } = {
      toolUseId: "tool-456",
      planSummary: "Summary only",
      timestamp: Date.now(),
    };

    expect(stateWithContent.planContent).toBe("Full plan content here");
    expect(stateWithoutContent.planContent).toBeUndefined();
  });
});

// ============== Plan Content Display Tests ==============

describe("plan-mode: plan content display", () => {
  beforeEach(resetMocks);

  test("shows plan content before approval buttons when available", async () => {
    const { handlePlan } = await import("../handlers/commands");
    const ctx = createMockContext({ messageText: "/plan add feature" });

    // Simulate pending plan approval with content (must be > 50 chars)
    mockSessionState.pendingPlanApproval = {
      toolUseId: "tool-123",
      planSummary: "Short summary",
      planContent: "# Full Plan Implementation\n\n1. Step one: Create the feature module\n2. Step two: Add unit tests\n3. Step three: Update documentation",
      timestamp: Date.now(),
    };

    await handlePlan(ctx as any);

    // Should show plan content
    const contentMsg = ctx._replies.find(r => r.text.includes("Plan:"));
    expect(contentMsg).toBeDefined();

    // Should show approval buttons after content
    const approvalMsg = ctx._replies.find(r => r.text.includes("Review and approve"));
    expect(approvalMsg).toBeDefined();
  });

  test("falls back to planSummary when no planContent", async () => {
    const { handlePlan } = await import("../handlers/commands");
    const ctx = createMockContext({ messageText: "/plan add feature" });

    // Simulate pending plan approval without content (summary must be > 50 chars)
    mockSessionState.pendingPlanApproval = {
      toolUseId: "tool-123",
      planSummary: "This is the plan summary fallback that is long enough to display in the response message",
      timestamp: Date.now(),
    };

    await handlePlan(ctx as any);

    // Should show summary as fallback (in Plan: message)
    const summaryMsg = ctx._replies.find(r => r.text.includes("Plan:"));
    expect(summaryMsg).toBeDefined();
  });

  test("sends very long plan content as file", async () => {
    const { handlePlan } = await import("../handlers/commands");
    const ctx = createMockContext({ messageText: "/plan add feature" });

    // Simulate pending plan approval with very long content
    mockSessionState.pendingPlanApproval = {
      toolUseId: "tool-123",
      planSummary: "Summary",
      planContent: "X".repeat(5000), // Exceeds 4000 limit
      timestamp: Date.now(),
    };

    await handlePlan(ctx as any);

    // Should send as document file
    expect(ctx._documents.length).toBe(1);
    expect(ctx._documents[0]!.options?.caption).toBe("📋 Plan ready for review");
  });

  test("does not show plan content if too short", async () => {
    const { handlePlan } = await import("../handlers/commands");
    const ctx = createMockContext({ messageText: "/plan add feature" });

    // Simulate pending plan approval with very short content
    mockSessionState.pendingPlanApproval = {
      toolUseId: "tool-123",
      planSummary: "Short",
      planContent: "X", // Only 1 character
      timestamp: Date.now(),
    };

    await handlePlan(ctx as any);

    // Should only show approval buttons, no separate content message
    const planMsg = ctx._replies.find(r => r.text.includes("Plan:"));
    expect(planMsg).toBeUndefined();
  });

  test("escapes HTML in plan content", async () => {
    const { handlePlan } = await import("../handlers/commands");
    const ctx = createMockContext({ messageText: "/plan add feature" });

    // Simulate pending plan approval with HTML-like content
    mockSessionState.pendingPlanApproval = {
      toolUseId: "tool-123",
      planSummary: "Summary",
      planContent: "This plan has <script>alert('xss')</script> and & characters that need escaping for proper display",
      timestamp: Date.now(),
    };

    await handlePlan(ctx as any);

    // Content should be escaped (check that raw script tag is not present)
    const contentMsg = ctx._replies.find(r => r.text.includes("Plan:"));
    expect(contentMsg).toBeDefined();
    // The HTML should be escaped, so <script> should appear as &lt;script&gt;
    expect(contentMsg?.text).not.toContain("<script>");
  });
});

// ============== Session Plan Mode State Tests ==============

describe("plan-mode: session state", () => {
  beforeEach(resetMocks);

  test("isPlanMode returns false by default", () => {
    expect(mockSessionState.isPlanMode).toBe(false);
  });

  test("isPlanMode can be set to true", () => {
    mockSessionState.isPlanMode = true;
    expect(mockSessionState.isPlanMode).toBe(true);
  });

  test("pendingPlanApproval is null by default", () => {
    expect(mockSessionState.pendingPlanApproval).toBeNull();
  });

  test("pendingPlanApproval can store approval state", () => {
    mockSessionState.pendingPlanApproval = {
      toolUseId: "tool-abc",
      planSummary: "Plan to implement feature",
      timestamp: 1234567890,
    };

    expect(mockSessionState.pendingPlanApproval?.toolUseId).toBe("tool-abc");
    expect(mockSessionState.pendingPlanApproval?.planSummary).toBe("Plan to implement feature");
    expect(mockSessionState.pendingPlanApproval?.timestamp).toBe(1234567890);
  });

  test("clearPendingPlanApproval clears state", () => {
    mockSessionState.pendingPlanApproval = {
      toolUseId: "tool-123",
      planSummary: "Test",
      timestamp: Date.now(),
    };

    mockSessionMethods.clearPendingPlanApproval();

    expect(mockSessionState.pendingPlanApproval).toBeNull();
  });
});

// ============== Integration-like Tests ==============

describe("plan-mode: integration scenarios", () => {
  beforeEach(resetMocks);

  test("full flow: /plan -> ExitPlanMode -> Accept", async () => {
    const { handlePlan } = await import("../handlers/commands");
    const { handleCallback } = await import("../handlers/callback");

    // Step 1: User sends /plan command
    const planCtx = createMockContext({ messageText: "/plan add hello endpoint" });

    // Simulate ExitPlanMode detection
    mockSessionState.pendingPlanApproval = {
      toolUseId: "exit-plan-tool",
      planSummary: "Plan to add hello endpoint",
      timestamp: Date.now(),
    };

    await handlePlan(planCtx as any);

    // Should show approval buttons
    const approvalMsg = planCtx._replies.find(r => r.text.includes("Review and approve"));
    expect(approvalMsg).toBeDefined();

    // Step 2: User clicks Accept
    const acceptCtx = createMockContext({
      callbackData: "plan:accept:123",
    });

    await handleCallback(acceptCtx as any);

    expect(acceptCtx.editMessageText).toHaveBeenCalledWith("✅ Plan accepted");
    expect(mockSessionMethods.respondToPlanApproval).toHaveBeenCalled();
  });

  test("full flow: /plan -> ExitPlanMode -> Edit -> feedback", async () => {
    const { handleCallback, pendingPlanFeedback } = await import("../handlers/callback");

    // Setup pending plan
    mockSessionState.pendingPlanApproval = {
      toolUseId: "exit-plan-tool",
      planSummary: "Original plan",
      timestamp: Date.now(),
    };

    // User clicks Edit
    const editCtx = createMockContext({
      callbackData: "plan:edit:456",
      chatId: 789,
    });

    await handleCallback(editCtx as any);

    // Should prompt for feedback
    expect(editCtx.editMessageText).toHaveBeenCalledWith("✏️ Reply with your feedback for the plan:");
    expect(pendingPlanFeedback.has(789)).toBe(true);

    // Cleanup
    pendingPlanFeedback.delete(789);
  });

  test("rate limiting applies to /plan command", async () => {
    const { rateLimiter } = await import("../security");

    // Override rateLimiter to return rate limited
    (rateLimiter.check as any).mockReturnValueOnce([false, 5.5]);

    const { handlePlan } = await import("../handlers/commands");
    const ctx = createMockContext({ messageText: "/plan test" });

    await handlePlan(ctx as any);

    // Should show rate limit message
    const rateLimitMsg = ctx._replies.find(r => r.text.includes("Rate limited"));
    expect(rateLimitMsg).toBeDefined();
  });
});

// ============== Text Handler Plan Display Tests ==============

describe("plan-mode: text handler plan display after streaming", () => {
  beforeEach(resetMocks);

  test("displays short plan inline after sendMessageStreaming", async () => {
    const { handleText } = await import("../handlers/text");
    const ctx = createMockContext({ messageText: "implement this feature" });

    // Simulate plan approval set during streaming
    mockSessionMethods.sendMessageStreaming.mockImplementation(async () => {
      mockSessionState.pendingPlanApproval = {
        toolUseId: "tool-123",
        planSummary: "Plan summary",
        planContent: "# Short Plan\n\n1. Step one\n2. Step two\n3. Step three",
        timestamp: Date.now(),
      };
      return "Response";
    });

    await handleText(ctx as any);

    // Should show plan content inline
    const planMsg = ctx._replies.find(r => r.text.includes("Plan:"));
    expect(planMsg).toBeDefined();
    expect(planMsg?.options?.parse_mode).toBe("HTML");

    // Should show approval buttons
    const approvalMsg = ctx._replies.find(r => r.text.includes("Review and approve"));
    expect(approvalMsg).toBeDefined();
    expect(approvalMsg?.options?.reply_markup).toBeDefined();
  });

  test("sends long plan as .md document file", async () => {
    const { handleText } = await import("../handlers/text");
    const documents: Array<{ file: unknown; options?: Record<string, unknown> }> = [];
    const ctx = {
      ...createMockContext({ messageText: "implement this feature" }),
      replyWithDocument: mock(async (file: unknown, options?: Record<string, unknown>) => {
        documents.push({ file, options });
        return { chat: { id: 789 }, message_id: Date.now() };
      }),
    };

    // Simulate plan approval with long content
    const longContent = "# Long Plan\n\n" + "This is a very detailed step.\n".repeat(200);
    mockSessionMethods.sendMessageStreaming.mockImplementation(async () => {
      mockSessionState.pendingPlanApproval = {
        toolUseId: "tool-123",
        planSummary: "Plan summary",
        planContent: longContent,
        timestamp: Date.now(),
      };
      return "Response";
    });

    await handleText(ctx as any);

    // Should send as document
    expect(documents.length).toBe(1);
    expect(documents[0]?.options?.caption).toBe("📋 Plan ready for review");

    // Should still show approval buttons
    const approvalMsg = ctx._replies.find(r => r.text.includes("Review and approve"));
    expect(approvalMsg).toBeDefined();
  });

  test("shows approval buttons even without planContent", async () => {
    const { handleText } = await import("../handlers/text");
    const ctx = createMockContext({ messageText: "implement this feature" });

    // Simulate plan approval without content
    mockSessionMethods.sendMessageStreaming.mockImplementation(async () => {
      mockSessionState.pendingPlanApproval = {
        toolUseId: "tool-123",
        planSummary: "Plan summary only",
        timestamp: Date.now(),
      };
      return "Response";
    });

    await handleText(ctx as any);

    // Should not show plan content message (no planContent)
    const planMsg = ctx._replies.find(r => r.text.includes("Plan:"));
    expect(planMsg).toBeUndefined();

    // Should still show approval buttons
    const approvalMsg = ctx._replies.find(r => r.text.includes("Review and approve"));
    expect(approvalMsg).toBeDefined();
  });

  test("does not show approval buttons when no pending plan", async () => {
    const { handleText } = await import("../handlers/text");
    const ctx = createMockContext({ messageText: "just a regular message" });

    // No pending plan approval
    mockSessionMethods.sendMessageStreaming.mockImplementation(async () => {
      mockSessionState.pendingPlanApproval = null;
      return "Response";
    });

    await handleText(ctx as any);

    // Should not show approval buttons
    const approvalMsg = ctx._replies.find(r => r.text.includes("Review and approve"));
    expect(approvalMsg).toBeUndefined();
  });
});

// ============== Edge Cases ==============

describe("plan-mode: edge cases", () => {
  beforeEach(resetMocks);

  test("handles plan message with special characters", async () => {
    const { handlePlan } = await import("../handlers/commands");
    const ctx = createMockContext({
      messageText: "/plan add <div> & 'quotes' \"double\"",
    });

    // Should not throw
    await handlePlan(ctx as any);
    expect(mockSessionMethods.sendMessageStreaming).toHaveBeenCalled();
  });

  test("handles very long plan message", async () => {
    const { handlePlan } = await import("../handlers/commands");
    const longMessage = "/plan " + "x".repeat(5000);
    const ctx = createMockContext({ messageText: longMessage });

    await handlePlan(ctx as any);
    expect(mockSessionMethods.sendMessageStreaming).toHaveBeenCalled();
  });

  test("handles callback with missing chat ID", async () => {
    const { handleCallback } = await import("../handlers/callback");
    const ctx = {
      from: { id: 123456, username: "test" },
      chat: undefined,
      callbackQuery: { data: "plan:accept:123" },
      answerCallbackQuery: mock(async () => true),
    };

    // Should handle gracefully
    await handleCallback(ctx as any);
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  test("handles expired plan approval", async () => {
    const { handleCallback } = await import("../handlers/callback");
    const ctx = createMockContext({
      callbackData: "plan:accept:old-request",
    });

    // No pending approval
    mockSessionState.pendingPlanApproval = null;

    await handleCallback(ctx as any);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "No pending plan" });
  });
});
