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
  BOT_DIR: "/tmp/test-bot-dir",
  TEMP_DIR: "/tmp/telegram-bot",
  TEMP_PATHS: ["/tmp/"],
  RELAY_PORT_FILE_PREFIX: "/tmp/channel-relay-",
  RELAY_CONNECT_TIMEOUT_MS: 3000,
  RELAY_RESPONSE_TIMEOUT_MS: 300000,
}));

// Mock sessions module
const mockSessions: Array<{ name: string; dir: string; lastActivity: number }> =
  [];
let mockActiveSession: {
  name: string;
  info: { dir: string; id?: string; name: string; lastActivity?: number };
} | null = null;

mock.module("../sessions", () => ({
  getSessions: mock(() => mockSessions),
  getActiveSession: mock(() => mockActiveSession),
  setActiveSession: mock((name: string) => {
    const found = mockSessions.find((s) => s.name === name);
    if (found) {
      mockActiveSession = {
        name: found.name,
        info: { dir: found.dir, name: found.name },
      };
      return true;
    }
    return false;
  }),
  addTelegramSession: mock((path: string, name?: string) => {
    const sessionName = name || `telegram-${Date.now()}`;
    const newSession = {
      name: sessionName,
      dir: path,
      lastActivity: Date.now(),
    };
    mockSessions.push(newSession);
    mockActiveSession = {
      name: sessionName,
      info: { dir: path, name: sessionName },
    };
    return newSession;
  }),
  forceRefresh: mock(() => Promise.resolve()),
  updatePinnedStatus: mock(() => Promise.resolve()),
  removeSession: mock(() => true),
  getGitBranch: mock(() => Promise.resolve("main")),
  getSession: mock(() => null),
  getRecentHistory: mock(() => Promise.resolve([])),
  formatHistoryMessage: mock(() => ""),
  sendSwitchHistory: mock(() => Promise.resolve()),
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
  pendingPlanApproval: null as {
    toolUseId: string;
    planSummary: string;
    planContent?: string;
    timestamp: number;
  } | null,
};

const mockSessionMethods = {
  stop: mock(() => Promise.resolve()),
  clearStopRequested: mock(() => {}),
  kill: mock(() => Promise.resolve()),
  setWorkingDir: mock((dir: string) => {
    mockSessionState.workingDir = dir;
  }),
  loadFromRegistry: mock((info: { dir: string; name: string }) => {
    mockSessionState.workingDir = info.dir;
    mockSessionState.sessionName = info.name;
  }),
  startProcessing: mock(() => () => {}),
  consumeInterruptFlag: mock(() => false),
  sendMessageStreaming: mock(async () => "Test response"),
  respondToPlanApproval: mock(async () => "Plan response"),
  clearPendingPlanApproval: mock(() => {
    mockSessionState.pendingPlanApproval = null;
  }),
};

mock.module("../session", () => ({
  session: {
    get isRunning() {
      return mockSessionState.isRunning;
    },
    get isActive() {
      return mockSessionState.isActive;
    },
    get sessionId() {
      return mockSessionState.sessionId;
    },
    set sessionId(val: string | null) {
      mockSessionState.sessionId = val;
    },
    get sessionName() {
      return mockSessionState.sessionName;
    },
    get workingDir() {
      return mockSessionState.workingDir;
    },
    get lastMessage() {
      return mockSessionState.lastMessage;
    },
    set lastMessage(val: string | null) {
      mockSessionState.lastMessage = val;
    },
    get lastActivity() {
      return mockSessionState.lastActivity;
    },
    get lastTool() {
      return mockSessionState.lastTool;
    },
    get currentTool() {
      return mockSessionState.currentTool;
    },
    get lastError() {
      return mockSessionState.lastError;
    },
    get lastUsage() {
      return mockSessionState.lastUsage;
    },
    get queryStarted() {
      return mockSessionState.queryStarted;
    },
    get isPlanMode() {
      return mockSessionState.isPlanMode;
    },
    get pendingPlanApproval() {
      return mockSessionState.pendingPlanApproval;
    },
    get model() {
      return "claude-opus-4-6";
    },
    get modelDisplayName() {
      return "Opus 4.6";
    },
    ...mockSessionMethods,
  },
  MODEL_DISPLAY_NAMES: {
    "claude-opus-4-6": "Opus 4.6",
    "claude-opus-4-5-20250514": "Opus 4.5",
    "claude-sonnet-4-5-20250514": "Sonnet 4.5",
    "claude-haiku-4-5-20250514": "Haiku 4.5",
  },
}));

// Mock security - must include all exports to avoid breaking other tests
mock.module("../security", () => ({
  isAuthorized: mock((userId: number, allowedUsers: number[]) =>
    allowedUsers.includes(userId),
  ),
  rateLimiter: {
    check: mock(() => [true, 0] as [boolean, number]),
    getStatus: mock(() => ({
      tokens: 20,
      lastUpdate: Date.now(),
      max: 20,
      refillRate: 1,
    })),
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
function createMockContext(
  overrides: Partial<{
    userId: number;
    username: string;
    chatId: number;
    messageText: string;
    callbackData: string;
  }> = {},
) {
  const {
    userId = 123456,
    username = "testuser",
    chatId = 789,
    messageText = "/plan test",
    callbackData,
  } = overrides;

  const replies: Array<{ text: string; options?: Record<string, unknown> }> =
    [];
  const editedMessages: Array<{
    text: string;
    options?: Record<string, unknown>;
  }> = [];
  const documents: Array<{ file: unknown; options?: Record<string, unknown> }> =
    [];

  return {
    from: { id: userId, username },
    chat: { id: chatId },
    message: { text: messageText, message_id: 1 },
    callbackQuery: callbackData ? { data: callbackData } : undefined,
    reply: mock(async (text: string, options?: Record<string, unknown>) => {
      replies.push({ text, options });
      return { chat: { id: chatId }, message_id: Date.now() };
    }),
    replyWithDocument: mock(
      async (file: unknown, options?: Record<string, unknown>) => {
        documents.push({ file, options });
        return { chat: { id: chatId }, message_id: Date.now() };
      },
    ),
    editMessageText: mock(
      async (text: string, options?: Record<string, unknown>) => {
        editedMessages.push({ text, options });
        return true;
      },
    ),
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
    const { createPlanApprovalKeyboard } =
      await import("../handlers/streaming");

    const keyboard = createPlanApprovalKeyboard("req-123");
    const data = (keyboard as any).inline_keyboard;

    expect(data).toBeDefined();
    expect(data.length).toBe(3);
  });

  test("creates correct callback data for each button", async () => {
    const { createPlanApprovalKeyboard } =
      await import("../handlers/streaming");

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
    const { createPlanApprovalKeyboard } =
      await import("../handlers/streaming");

    const keyboard = createPlanApprovalKeyboard("test");
    const data = (keyboard as any).inline_keyboard;

    expect(data[0][0].text).toBe("✅ Accept");
    expect(data[1][0].text).toBe("❌ Reject");
    expect(data[2][0].text).toBe("✏️ Edit");
  });

  test("handles different request IDs", async () => {
    const { createPlanApprovalKeyboard } =
      await import("../handlers/streaming");

    const keyboard1 = createPlanApprovalKeyboard("id-1");
    const keyboard2 = createPlanApprovalKeyboard("id-2");

    const data1 = (keyboard1 as any).inline_keyboard;
    const data2 = (keyboard2 as any).inline_keyboard;

    expect(data1[0][0].callback_data).toBe("plan:accept:id-1");
    expect(data2[0][0].callback_data).toBe("plan:accept:id-2");
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

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Unauthorized",
    });
  });

  test("handles missing pending plan approval", async () => {
    const { handleCallback } = await import("../handlers/callback");
    const ctx = createMockContext({
      callbackData: "plan:accept:123",
    });

    mockSessionState.pendingPlanApproval = null;

    await handleCallback(ctx as any);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "No pending plan",
    });
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
    const { handleCallback, pendingPlanFeedback } =
      await import("../handlers/callback");
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
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      "✏️ Reply with your feedback for the plan:",
    );
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Send your feedback",
    });

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
    expect(
      mockSessionMethods.respondToPlanApproval.mock.calls.length,
    ).toBeGreaterThan(0);
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
    expect(
      mockSessionMethods.respondToPlanApproval.mock.calls.length,
    ).toBeGreaterThan(0);
  });

  test("handles invalid callback data format", async () => {
    const { handleCallback } = await import("../handlers/callback");
    const ctx = createMockContext({
      callbackData: "plan:invalid",
    });

    await handleCallback(ctx as any);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Invalid callback",
    });
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
    const state: {
      toolUseId: string;
      planSummary: string;
      planContent?: string;
      timestamp: number;
    } = {
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
    const state: {
      toolUseId: string;
      planSummary: string;
      planContent?: string;
      timestamp: number;
    } = {
      toolUseId: "tool-123",
      planSummary: longPlan.slice(0, 500),
      timestamp: Date.now(),
    };

    expect(state.planSummary.length).toBe(500);
  });

  test("planContent is optional", async () => {
    const stateWithContent: {
      toolUseId: string;
      planSummary: string;
      planContent?: string;
      timestamp: number;
    } = {
      toolUseId: "tool-123",
      planSummary: "Summary",
      planContent: "Full plan content here",
      timestamp: Date.now(),
    };

    const stateWithoutContent: {
      toolUseId: string;
      planSummary: string;
      planContent?: string;
      timestamp: number;
    } = {
      toolUseId: "tool-456",
      planSummary: "Summary only",
      timestamp: Date.now(),
    };

    expect(stateWithContent.planContent).toBe("Full plan content here");
    expect(stateWithoutContent.planContent).toBeUndefined();
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
    expect(mockSessionState.pendingPlanApproval?.planSummary).toBe(
      "Plan to implement feature",
    );
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

  test("full flow: ExitPlanMode -> Edit -> feedback", async () => {
    const { handleCallback, pendingPlanFeedback } =
      await import("../handlers/callback");

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
    expect(editCtx.editMessageText).toHaveBeenCalledWith(
      "✏️ Reply with your feedback for the plan:",
    );
    expect(pendingPlanFeedback.has(789)).toBe(true);

    // Cleanup
    pendingPlanFeedback.delete(789);
  });
});

// ============== Edge Cases ==============

describe("plan-mode: edge cases", () => {
  beforeEach(resetMocks);

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

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "No pending plan",
    });
  });
});
