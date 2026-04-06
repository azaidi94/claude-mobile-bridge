/**
 * Unit tests for AskUserQuestion handling.
 *
 * Tests keyboard creation, sequential question flow, custom input,
 * skip functionality, and state management.
 */

import { describe, expect, test, beforeEach, mock } from "bun:test";

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
mock.module("../sessions", () => ({
  getSessions: mock(() => []),
  getActiveSession: mock(() => null),
  setActiveSession: mock(() => false),
  addTelegramSession: mock(() => ({ name: "test", dir: "/tmp" })),
  forceRefresh: mock(() => Promise.resolve()),
  updatePinnedStatus: mock(() => Promise.resolve()),
  removeSession: mock(() => true),
  getGitBranch: mock(() => Promise.resolve("main")),
  getSession: mock(() => null),
  getRecentHistory: mock(() => Promise.resolve([])),
  formatHistoryMessage: mock(() => ""),
  sendSwitchHistory: mock(() => Promise.resolve()),
  suppressDirNotifications: mock(() => {}),
}));

// Mock session singleton
const mockSessionState = {
  isRunning: false,
  isActive: false,
  sessionId: null as string | null,
  sessionName: null as string | null,
  workingDir: "/tmp/test-working-dir",
  pendingPlanApproval: null as any,
  isPlanMode: false,
};

const mockSessionMethods = {
  stop: mock(() => Promise.resolve()),
  clearStopRequested: mock(() => {}),
  sendMessageStreaming: mock(async () => "Test response"),
  respondToPlanApproval: mock(async () => "Plan response"),
  startProcessing: mock(() => () => {}),
  consumeInterruptFlag: mock(() => false),
  loadFromRegistry: mock(() => {}),
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
    get sessionName() {
      return mockSessionState.sessionName;
    },
    get workingDir() {
      return mockSessionState.workingDir;
    },
    get pendingPlanApproval() {
      return mockSessionState.pendingPlanApproval;
    },
    get isPlanMode() {
      return mockSessionState.isPlanMode;
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

// Mock security
mock.module("../security", () => ({
  isAuthorized: mock((userId: number, allowedUsers: number[]) =>
    allowedUsers.includes(userId),
  ),
  rateLimiter: {
    check: mock(() => [true, 0] as [boolean, number]),
  },
  checkCommandSafety: mock(() => [true, ""]),
  isPathAllowed: mock(() => true),
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
    callbackData: string;
    messageText: string;
  }> = {},
) {
  const {
    userId = 123456,
    username = "testuser",
    chatId = 789,
    callbackData,
    messageText,
  } = overrides;

  const replies: Array<{ text: string; options?: Record<string, unknown> }> =
    [];
  const editedMessages: Array<{
    text: string;
    options?: Record<string, unknown>;
  }> = [];

  return {
    from: { id: userId, username },
    chat: { id: chatId },
    message: messageText ? { text: messageText, message_id: 1 } : undefined,
    callbackQuery: callbackData ? { data: callbackData } : undefined,
    reply: mock(async (text: string, options?: Record<string, unknown>) => {
      replies.push({ text, options });
      return { chat: { id: chatId }, message_id: Date.now() };
    }),
    editMessageText: mock(
      async (text: string, options?: Record<string, unknown>) => {
        editedMessages.push({ text, options });
        return true;
      },
    ),
    answerCallbackQuery: mock(async () => true),
    api: {
      editMessageText: mock(async () => ({})),
      deleteMessage: mock(async () => true),
    },
    _replies: replies,
    _editedMessages: editedMessages,
  };
}

function resetMocks() {
  mockSessionState.isRunning = false;
  mockSessionState.pendingPlanApproval = null;
  mockSessionMethods.sendMessageStreaming.mockClear();
}

// ============== createAskUserQuestionKeyboard Tests ==============

describe("AskUserQuestion: createAskUserQuestionKeyboard", () => {
  beforeEach(resetMocks);

  test("creates keyboard with options + custom + skip buttons", async () => {
    const { createAskUserQuestionKeyboard } =
      await import("../handlers/streaming");

    const question = {
      question: "Which framework?",
      options: [{ label: "React" }, { label: "Vue" }],
    };
    const keyboard = createAskUserQuestionKeyboard(question, "req123", 0, 2);

    const data = (keyboard as any).inline_keyboard;
    expect(data).toBeDefined();

    // Should have: React, Vue, Custom, Skip (4 rows + trailing)
    expect(data.length).toBeGreaterThanOrEqual(4);

    // Check option buttons
    expect(data[0][0].text).toBe("React");
    expect(data[0][0].callback_data).toBe("auq:req123:opt:0");
    expect(data[1][0].text).toBe("Vue");
    expect(data[1][0].callback_data).toBe("auq:req123:opt:1");

    // Check custom button
    const customRow = data.find((row: any) => row[0]?.text?.includes("Custom"));
    expect(customRow).toBeDefined();
    expect(customRow[0].callback_data).toBe("auq:req123:custom");

    // Check skip button
    const skipRow = data.find((row: any) => row[0]?.text?.includes("Skip"));
    expect(skipRow).toBeDefined();
    expect(skipRow[0].callback_data).toBe("auq:req123:skip");
  });

  test("truncates long option labels", async () => {
    const { createAskUserQuestionKeyboard } =
      await import("../handlers/streaming");

    const question = {
      question: "Pick one",
      options: [{ label: "A".repeat(50) }],
    };
    const keyboard = createAskUserQuestionKeyboard(question, "req123", 0, 1);

    const data = (keyboard as any).inline_keyboard;
    const buttonText = data[0][0].text;
    expect(buttonText.length).toBeLessThanOrEqual(33); // 30 + "..."
    expect(buttonText.endsWith("...")).toBe(true);
  });

  test("handles single question (still shows skip)", async () => {
    const { createAskUserQuestionKeyboard } =
      await import("../handlers/streaming");

    const question = {
      question: "Choose one",
      options: [{ label: "A" }, { label: "B" }],
    };
    const keyboard = createAskUserQuestionKeyboard(question, "req123", 0, 1);

    const data = (keyboard as any).inline_keyboard;
    const skipRow = data.find((row: any) => row[0]?.text?.includes("Skip"));
    expect(skipRow).toBeDefined();
  });

  test("includes correct callback data format", async () => {
    const { createAskUserQuestionKeyboard } =
      await import("../handlers/streaming");

    const question = {
      question: "Select",
      options: [
        { label: "Option A" },
        { label: "Option B" },
        { label: "Option C" },
      ],
    };
    const keyboard = createAskUserQuestionKeyboard(question, "abc-def", 0, 3);

    const data = (keyboard as any).inline_keyboard;
    expect(data[0][0].callback_data).toBe("auq:abc-def:opt:0");
    expect(data[1][0].callback_data).toBe("auq:abc-def:opt:1");
    expect(data[2][0].callback_data).toBe("auq:abc-def:opt:2");
  });
});

// ============== checkPendingAskUserQuestionRequests Tests ==============

describe("AskUserQuestion: checkPendingAskUserQuestionRequests", () => {
  beforeEach(resetMocks);

  test("returns true and sends keyboard when valid input provided", async () => {
    const { checkPendingAskUserQuestionRequests, pendingAskUserQuestions } =
      await import("../handlers/streaming");
    const ctx = createMockContext();

    const input = {
      questions: [
        {
          question: "Which library?",
          options: [{ label: "React" }, { label: "Vue" }],
        },
      ],
    };

    const result = await checkPendingAskUserQuestionRequests(
      ctx as any,
      789,
      input,
      "tool-123",
    );

    expect(result).toBe(true);
    expect(ctx._replies.length).toBe(1);
    expect(ctx._replies[0]?.text).toContain("Which library?");
    expect(ctx._replies[0]?.options?.reply_markup).toBeDefined();

    // Should store pending state
    expect(pendingAskUserQuestions.size).toBeGreaterThan(0);

    // Cleanup
    pendingAskUserQuestions.clear();
  });

  test("returns false when no questions provided", async () => {
    const { checkPendingAskUserQuestionRequests } =
      await import("../handlers/streaming");
    const ctx = createMockContext();

    const input = { questions: [] };

    const result = await checkPendingAskUserQuestionRequests(
      ctx as any,
      789,
      input,
      "tool-123",
    );

    expect(result).toBe(false);
    expect(ctx._replies.length).toBe(0);
  });

  test("includes header in question text when provided", async () => {
    const { checkPendingAskUserQuestionRequests, pendingAskUserQuestions } =
      await import("../handlers/streaming");
    const ctx = createMockContext();

    const input = {
      questions: [
        {
          question: "Which one?",
          header: "Framework Choice",
          options: [{ label: "A" }],
        },
      ],
    };

    await checkPendingAskUserQuestionRequests(
      ctx as any,
      789,
      input,
      "tool-123",
    );

    expect(ctx._replies[0]?.text).toContain("Framework Choice");

    // Cleanup
    pendingAskUserQuestions.clear();
  });

  test("includes option descriptions when provided", async () => {
    const { checkPendingAskUserQuestionRequests, pendingAskUserQuestions } =
      await import("../handlers/streaming");
    const ctx = createMockContext();

    const input = {
      questions: [
        {
          question: "Pick one",
          options: [
            { label: "React", description: "A library for building UIs" },
            { label: "Vue", description: "Progressive framework" },
          ],
        },
      ],
    };

    await checkPendingAskUserQuestionRequests(
      ctx as any,
      789,
      input,
      "tool-123",
    );

    expect(ctx._replies[0]?.text).toContain("A library for building UIs");
    expect(ctx._replies[0]?.text).toContain("Progressive framework");

    // Cleanup
    pendingAskUserQuestions.clear();
  });
});

// ============== pendingAskUserQuestions State Tests ==============

describe("AskUserQuestion: state management", () => {
  beforeEach(resetMocks);

  test("pendingAskUserQuestions stores question state", async () => {
    const { pendingAskUserQuestions } = await import("../handlers/streaming");

    pendingAskUserQuestions.set("req-123", {
      toolUseId: "tool-abc",
      questions: [{ question: "Q1", options: [{ label: "A" }] }],
      currentIndex: 0,
      answers: [],
      chatId: 789,
      isPlanMode: false,
    });

    const state = pendingAskUserQuestions.get("req-123");
    expect(state).toBeDefined();
    expect(state?.toolUseId).toBe("tool-abc");
    expect(state?.currentIndex).toBe(0);
    expect(state?.answers.length).toBe(0);

    // Cleanup
    pendingAskUserQuestions.delete("req-123");
  });

  test("pendingAskUserQuestionCustom tracks custom input state", async () => {
    const { pendingAskUserQuestionCustom } =
      await import("../handlers/streaming");

    pendingAskUserQuestionCustom.set(789, "req-456");

    expect(pendingAskUserQuestionCustom.get(789)).toBe("req-456");

    // Cleanup
    pendingAskUserQuestionCustom.delete(789);
  });

  test("answers accumulate across questions", async () => {
    const { pendingAskUserQuestions } = await import("../handlers/streaming");

    const state = {
      toolUseId: "tool-abc",
      questions: [
        { question: "Q1", options: [{ label: "A" }] },
        { question: "Q2", options: [{ label: "B" }] },
      ],
      currentIndex: 0,
      answers: [] as string[],
      chatId: 789,
      isPlanMode: false,
    };

    pendingAskUserQuestions.set("req-123", state);

    // Simulate answering questions
    state.answers.push("A");
    state.currentIndex++;
    state.answers.push("B");
    state.currentIndex++;

    expect(state.answers).toEqual(["A", "B"]);
    expect(state.currentIndex).toBe(2);

    // Cleanup
    pendingAskUserQuestions.delete("req-123");
  });
});

// ============== Callback Handler Tests ==============

describe("AskUserQuestion: callback handling", () => {
  beforeEach(resetMocks);

  test("handles option selection callback", async () => {
    const { handleCallback } = await import("../handlers/callback");
    const { pendingAskUserQuestions } = await import("../handlers/streaming");

    // Setup pending state
    pendingAskUserQuestions.set("req-123", {
      toolUseId: "tool-abc",
      questions: [
        {
          question: "Q1",
          options: [{ label: "Option A" }, { label: "Option B" }],
        },
      ],
      currentIndex: 0,
      answers: [],
      chatId: 789,
      isPlanMode: false,
    });

    const ctx = createMockContext({
      callbackData: "auq:req-123:opt:0",
      chatId: 789,
    });

    await handleCallback(ctx as any);

    // Should acknowledge the selection
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();

    // Cleanup
    pendingAskUserQuestions.clear();
  });

  test("handles skip callback", async () => {
    const { handleCallback } = await import("../handlers/callback");
    const { pendingAskUserQuestions } = await import("../handlers/streaming");

    // Setup pending state
    pendingAskUserQuestions.set("req-456", {
      toolUseId: "tool-def",
      questions: [{ question: "Q1", options: [{ label: "A" }] }],
      currentIndex: 0,
      answers: [],
      chatId: 789,
      isPlanMode: false,
    });

    const ctx = createMockContext({
      callbackData: "auq:req-456:skip",
      chatId: 789,
    });

    await handleCallback(ctx as any);

    // Should edit message to show skipped
    expect(ctx._editedMessages.some((m) => m.text.includes("Skipped"))).toBe(
      true,
    );

    // Should clear pending state
    expect(pendingAskUserQuestions.has("req-456")).toBe(false);

    // Cleanup
    pendingAskUserQuestions.clear();
  });

  test("handles custom callback", async () => {
    const { handleCallback } = await import("../handlers/callback");
    const { pendingAskUserQuestions, pendingAskUserQuestionCustom } =
      await import("../handlers/streaming");

    // Setup pending state
    pendingAskUserQuestions.set("req-789", {
      toolUseId: "tool-ghi",
      questions: [
        { question: "What is your preference?", options: [{ label: "A" }] },
      ],
      currentIndex: 0,
      answers: [],
      chatId: 789,
      isPlanMode: false,
    });

    const ctx = createMockContext({
      callbackData: "auq:req-789:custom",
      chatId: 789,
    });

    await handleCallback(ctx as any);

    // Should prompt for custom input
    expect(
      ctx._editedMessages.some((m) => m.text.includes("Type your answer")),
    ).toBe(true);

    // Should store custom input state
    expect(pendingAskUserQuestionCustom.get(789)).toBe("req-789");

    // Cleanup
    pendingAskUserQuestions.clear();
    pendingAskUserQuestionCustom.clear();
  });

  test("handles expired request", async () => {
    const { handleCallback } = await import("../handlers/callback");

    const ctx = createMockContext({
      callbackData: "auq:nonexistent:opt:0",
      chatId: 789,
    });

    await handleCallback(ctx as any);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Expired" });
  });

  test("handles invalid option index", async () => {
    const { handleCallback } = await import("../handlers/callback");
    const { pendingAskUserQuestions } = await import("../handlers/streaming");

    pendingAskUserQuestions.set("req-bad", {
      toolUseId: "tool-bad",
      questions: [{ question: "Q", options: [{ label: "A" }] }],
      currentIndex: 0,
      answers: [],
      chatId: 789,
      isPlanMode: false,
    });

    const ctx = createMockContext({
      callbackData: "auq:req-bad:opt:99", // Invalid index
      chatId: 789,
    });

    await handleCallback(ctx as any);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Invalid option",
    });

    // Cleanup
    pendingAskUserQuestions.clear();
  });

  test("advances to next question on selection", async () => {
    const { handleCallback } = await import("../handlers/callback");
    const { pendingAskUserQuestions } = await import("../handlers/streaming");

    pendingAskUserQuestions.set("req-multi", {
      toolUseId: "tool-multi",
      questions: [
        { question: "Q1", options: [{ label: "A1" }] },
        { question: "Q2", options: [{ label: "A2" }] },
      ],
      currentIndex: 0,
      answers: [],
      chatId: 789,
      isPlanMode: false,
    });

    const ctx = createMockContext({
      callbackData: "auq:req-multi:opt:0",
      chatId: 789,
    });

    await handleCallback(ctx as any);

    // Should show next question
    expect(ctx._editedMessages.some((m) => m.text.includes("Q2"))).toBe(true);

    // State should be updated
    const state = pendingAskUserQuestions.get("req-multi");
    expect(state?.currentIndex).toBe(1);
    expect(state?.answers).toContain("A1");

    // Cleanup
    pendingAskUserQuestions.clear();
  });

  test("sends answers to Claude on last question", async () => {
    const { handleCallback } = await import("../handlers/callback");
    const { pendingAskUserQuestions } = await import("../handlers/streaming");

    pendingAskUserQuestions.set("req-last", {
      toolUseId: "tool-last",
      questions: [{ question: "Q1", options: [{ label: "Final Answer" }] }],
      currentIndex: 0,
      answers: [],
      chatId: 789,
      isPlanMode: false,
    });

    const ctx = createMockContext({
      callbackData: "auq:req-last:opt:0",
      chatId: 789,
    });

    await handleCallback(ctx as any);

    // Should show completion message
    expect(ctx._editedMessages.some((m) => m.text.includes("Answered"))).toBe(
      true,
    );

    // Should send to Claude
    expect(mockSessionMethods.sendMessageStreaming).toHaveBeenCalled();

    // State should be cleared
    expect(pendingAskUserQuestions.has("req-last")).toBe(false);

    // Cleanup
    pendingAskUserQuestions.clear();
  });
});

// ============== Text Handler Custom Input Tests ==============

describe("AskUserQuestion: custom text input", () => {
  beforeEach(resetMocks);

  test("captures custom text as answer", async () => {
    const { handleText } = await import("../handlers/text");
    const { pendingAskUserQuestions, pendingAskUserQuestionCustom } =
      await import("../handlers/streaming");

    // Setup pending custom input state
    pendingAskUserQuestions.set("req-custom", {
      toolUseId: "tool-custom",
      questions: [{ question: "Q1", options: [{ label: "A" }] }],
      currentIndex: 0,
      answers: [],
      chatId: 789,
      isPlanMode: false,
    });
    pendingAskUserQuestionCustom.set(789, "req-custom");

    const ctx = createMockContext({
      messageText: "My custom answer",
      chatId: 789,
    });

    await handleText(ctx as any);

    // Should show completion
    expect(ctx._replies.some((r) => r.text.includes("Answered"))).toBe(true);

    // Custom input state should be cleared
    expect(pendingAskUserQuestionCustom.has(789)).toBe(false);

    // Cleanup
    pendingAskUserQuestions.clear();
    pendingAskUserQuestionCustom.clear();
  });

  test("advances to next question with custom answer", async () => {
    const { handleText } = await import("../handlers/text");
    const { pendingAskUserQuestions, pendingAskUserQuestionCustom } =
      await import("../handlers/streaming");

    // Setup multi-question state
    pendingAskUserQuestions.set("req-custom-multi", {
      toolUseId: "tool-custom-multi",
      questions: [
        { question: "Q1", options: [{ label: "A1" }] },
        { question: "Q2", options: [{ label: "A2" }] },
      ],
      currentIndex: 0,
      answers: [],
      chatId: 789,
      isPlanMode: false,
    });
    pendingAskUserQuestionCustom.set(789, "req-custom-multi");

    const ctx = createMockContext({
      messageText: "Custom for Q1",
      chatId: 789,
    });

    await handleText(ctx as any);

    // Should show Q2
    expect(ctx._replies.some((r) => r.text.includes("Q2"))).toBe(true);

    // State should be updated
    const state = pendingAskUserQuestions.get("req-custom-multi");
    expect(state?.answers).toContain("Custom for Q1");
    expect(state?.currentIndex).toBe(1);

    // Cleanup
    pendingAskUserQuestions.clear();
    pendingAskUserQuestionCustom.clear();
  });

  test("handles expired custom input state", async () => {
    const { handleText } = await import("../handlers/text");
    const { pendingAskUserQuestionCustom } =
      await import("../handlers/streaming");

    // Setup expired state (no matching question state)
    pendingAskUserQuestionCustom.set(789, "req-expired");

    const ctx = createMockContext({
      messageText: "Late answer",
      chatId: 789,
    });

    await handleText(ctx as any);

    // Should show expired message
    expect(ctx._replies.some((r) => r.text.includes("expired"))).toBe(true);

    // Cleanup
    pendingAskUserQuestionCustom.clear();
  });
});

// ============== Edge Cases ==============

describe("AskUserQuestion: edge cases", () => {
  beforeEach(resetMocks);

  test("handles unauthorized user", async () => {
    const { handleCallback } = await import("../handlers/callback");
    const ctx = createMockContext({
      userId: 999999, // Not in MOCK_ALLOWED_USERS
      callbackData: "auq:req-123:opt:0",
    });

    await handleCallback(ctx as any);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Unauthorized",
    });
  });

  test("handles malformed callback data", async () => {
    const { handleCallback } = await import("../handlers/callback");
    const ctx = createMockContext({
      callbackData: "auq:malformed",
    });

    await handleCallback(ctx as any);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Invalid callback",
    });
  });

  test("handles question with no options", async () => {
    const { createAskUserQuestionKeyboard } =
      await import("../handlers/streaming");

    const question = {
      question: "No options question",
      options: [],
    };
    const keyboard = createAskUserQuestionKeyboard(question, "req123", 0, 1);

    const data = (keyboard as any).inline_keyboard;
    // Should still have custom and skip buttons
    expect(data.length).toBeGreaterThanOrEqual(2);
  });

  test("handles question with many options", async () => {
    const { createAskUserQuestionKeyboard } =
      await import("../handlers/streaming");

    const question = {
      question: "Many options",
      options: Array.from({ length: 10 }, (_, i) => ({
        label: `Option ${i + 1}`,
      })),
    };
    const keyboard = createAskUserQuestionKeyboard(question, "req123", 0, 1);

    const data = (keyboard as any).inline_keyboard;
    // Should have all 10 options + custom + skip
    expect(data.length).toBeGreaterThanOrEqual(12);
  });
});
