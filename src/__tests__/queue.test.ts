/**
 * Unit tests for task queue functionality.
 *
 * Tests parseTasks(), TaskQueue class, and /queue command handler.
 */

import { describe, expect, test, beforeEach, mock } from "bun:test";

// Mock config before importing anything
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
let mockActiveSession: {
  name: string;
  info: { dir: string; id?: string; name: string };
} | null = null;

mock.module("../sessions", () => ({
  getSessions: mock(() => []),
  getActiveSession: mock(() => mockActiveSession),
  setActiveSession: mock(() => true),
  addTelegramSession: mock(() => ({ name: "test", dir: "/tmp" })),
  forceRefresh: mock(() => Promise.resolve()),
  updatePinnedStatus: mock(() => Promise.resolve()),
  removeSession: mock(() => true),
  getGitBranch: mock(() => Promise.resolve("main")),
  getSession: mock(() => null),
  getRecentHistory: mock(() => Promise.resolve([])),
  formatHistoryMessage: mock(() => ""),
}));

// Mock session singleton
const mockSessionState = {
  isRunning: false,
  isActive: false,
  sessionId: null as string | null,
  sessionName: null as string | null,
  workingDir: "/tmp/test-working-dir",
  isPlanMode: false,
  pendingPlanApproval: null,
  lastMessage: null as string | null,
};

mock.module("../session", () => ({
  session: {
    get isRunning() {
      return mockSessionState.isRunning;
    },
    get isActive() {
      return mockSessionState.isActive;
    },
    get sessionName() {
      return mockSessionState.sessionName;
    },
    get workingDir() {
      return mockSessionState.workingDir;
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
    stop: mock(() => Promise.resolve(false as "stopped" | "pending" | false)),
    clearStopRequested: mock(() => {}),
    kill: mock(() => Promise.resolve()),
    startProcessing: mock(() => () => {}),
    sendMessageStreaming: mock(() => Promise.resolve("Done")),
    loadFromRegistry: mock(() => {}),
    setWorkingDir: mock(() => {}),
  },
  MODEL_DISPLAY_NAMES: {
    "claude-opus-4-6": "Opus 4.6",
    opus: "Opus 4.6",
    sonnet: "Sonnet 4.6",
    haiku: "Haiku 4.5",
  },
}));

// Mock utils
mock.module("../utils", () => ({
  auditLog: mock(() => Promise.resolve()),
  auditLogRateLimit: mock(() => Promise.resolve()),
  startTypingIndicator: mock(() => ({ stop: () => {} })),
  checkInterrupt: mock((text: string) => Promise.resolve(text)),
}));

// Test helpers
function createMockContext(
  overrides: Partial<{
    userId: number;
    username: string;
    chatId: number;
    messageText: string;
  }> = {},
) {
  const {
    userId = 123456,
    username = "testuser",
    chatId = 789,
    messageText = "/test",
  } = overrides;

  const replies: Array<{ text: string; options?: Record<string, unknown> }> =
    [];

  return {
    from: { id: userId, username },
    chat: { id: chatId },
    message: { text: messageText, message_id: 1 },
    reply: mock(async (text: string, options?: Record<string, unknown>) => {
      replies.push({ text, options });
      return { chat: { id: chatId }, message_id: Date.now() };
    }),
    api: {
      sendMessage: mock(async () => ({ message_id: Date.now() })),
      editMessageText: mock(async () => ({})),
      deleteMessage: mock(async () => ({})),
    },
    replyWithChatAction: mock(async () => {}),
    _replies: replies,
  };
}

function resetMocks() {
  mockActiveSession = null;
  mockSessionState.isRunning = false;
  mockSessionState.isActive = false;
  mockSessionState.sessionId = null;
  mockSessionState.sessionName = null;
  mockSessionState.workingDir = "/tmp/test-working-dir";
}

// ============== parseTasks Tests ==============

describe("queue: parseTasks", () => {
  test("parses numbered list with dots", async () => {
    const { parseTasks } = await import("../queue");

    const tasks = parseTasks(
      "1. Fix the failing test\n2. Add input validation\n3. Write tests",
    );

    expect(tasks).toEqual([
      "Fix the failing test",
      "Add input validation",
      "Write tests",
    ]);
  });

  test("parses numbered list with parentheses", async () => {
    const { parseTasks } = await import("../queue");

    const tasks = parseTasks(
      "1) Fix the test\n2) Add validation\n3) Write tests",
    );

    expect(tasks).toEqual(["Fix the test", "Add validation", "Write tests"]);
  });

  test("parses bulleted list with dashes", async () => {
    const { parseTasks } = await import("../queue");

    const tasks = parseTasks("- Fix the test\n- Add validation\n- Write tests");

    expect(tasks).toEqual(["Fix the test", "Add validation", "Write tests"]);
  });

  test("parses bulleted list with asterisks", async () => {
    const { parseTasks } = await import("../queue");

    const tasks = parseTasks("* Fix the test\n* Add validation\n* Write tests");

    expect(tasks).toEqual(["Fix the test", "Add validation", "Write tests"]);
  });

  test("parses bulleted list with bullets", async () => {
    const { parseTasks } = await import("../queue");

    const tasks = parseTasks("• Fix the test\n• Add validation\n• Write tests");

    expect(tasks).toEqual(["Fix the test", "Add validation", "Write tests"]);
  });

  test("parses plain newline-separated tasks", async () => {
    const { parseTasks } = await import("../queue");

    const tasks = parseTasks("Fix the test\nAdd validation\nWrite tests");

    expect(tasks).toEqual(["Fix the test", "Add validation", "Write tests"]);
  });

  test("skips empty lines", async () => {
    const { parseTasks } = await import("../queue");

    const tasks = parseTasks(
      "1. Fix the test\n\n2. Add validation\n\n3. Write tests",
    );

    expect(tasks).toEqual(["Fix the test", "Add validation", "Write tests"]);
  });

  test("handles whitespace around tasks", async () => {
    const { parseTasks } = await import("../queue");

    const tasks = parseTasks("  1. Fix the test  \n  2. Add validation  ");

    expect(tasks).toEqual(["Fix the test", "Add validation"]);
  });

  test("returns empty array for empty input", async () => {
    const { parseTasks } = await import("../queue");

    const tasks = parseTasks("");
    expect(tasks).toEqual([]);
  });

  test("returns empty array for whitespace-only input", async () => {
    const { parseTasks } = await import("../queue");

    const tasks = parseTasks("   \n  \n  ");
    expect(tasks).toEqual([]);
  });

  test("handles single task", async () => {
    const { parseTasks } = await import("../queue");

    const tasks = parseTasks("Fix the failing test");
    expect(tasks).toEqual(["Fix the failing test"]);
  });

  test("handles numbered list with colons", async () => {
    const { parseTasks } = await import("../queue");

    const tasks = parseTasks("1: Fix the test\n2: Add validation");
    expect(tasks).toEqual(["Fix the test", "Add validation"]);
  });
});

// ============== TaskQueue Class Tests ==============

describe("queue: TaskQueue", () => {
  beforeEach(resetMocks);

  test("constructor creates tasks from descriptions", async () => {
    const { TaskQueue } = await import("../queue");

    const queue = new TaskQueue(
      ["Task 1", "Task 2", "Task 3"],
      789,
      123456,
      "testuser",
    );

    expect(queue.tasks).toHaveLength(3);
    expect(queue.tasks[0]!.description).toBe("Task 1");
    expect(queue.tasks[0]!.status).toBe("pending");
    expect(queue.tasks[0]!.index).toBe(0);
    expect(queue.tasks[1]!.index).toBe(1);
    expect(queue.tasks[2]!.index).toBe(2);
  });

  test("completedCount returns number of completed tasks", async () => {
    const { TaskQueue } = await import("../queue");

    const queue = new TaskQueue(
      ["Task 1", "Task 2", "Task 3"],
      789,
      123456,
      "testuser",
    );

    expect(queue.completedCount).toBe(0);

    queue.tasks[0]!.status = "completed";
    expect(queue.completedCount).toBe(1);

    queue.tasks[1]!.status = "completed";
    expect(queue.completedCount).toBe(2);
  });

  test("failedCount returns number of failed tasks", async () => {
    const { TaskQueue } = await import("../queue");

    const queue = new TaskQueue(["Task 1", "Task 2"], 789, 123456, "testuser");

    expect(queue.failedCount).toBe(0);

    queue.tasks[0]!.status = "failed";
    expect(queue.failedCount).toBe(1);
  });

  test("cancel sets cancelled flag and skips pending tasks", async () => {
    const { TaskQueue } = await import("../queue");

    const queue = new TaskQueue(
      ["Task 1", "Task 2", "Task 3"],
      789,
      123456,
      "testuser",
    );

    queue.tasks[0]!.status = "completed";
    queue.tasks[1]!.status = "running";
    queue.currentTaskIndex = 1;

    queue.cancel();

    expect(queue.cancelled).toBe(true);
    expect(queue.tasks[0]!.status).toBe("completed");
    // Task 1 (running) stays running - it finishes naturally
    expect(queue.tasks[1]!.status).toBe("running");
    expect(queue.tasks[2]!.status).toBe("skipped");
  });

  test("formatProgress shows task statuses", async () => {
    const { TaskQueue } = await import("../queue");

    const queue = new TaskQueue(
      ["Fix test", "Add validation"],
      789,
      123456,
      "testuser",
    );

    queue.tasks[0]!.status = "completed";
    queue.tasks[1]!.status = "running";

    const progress = queue.formatProgress();

    expect(progress).toContain("Queue Progress");
    expect(progress).toContain("✅");
    expect(progress).toContain("🔄");
    expect(progress).toContain("Fix test");
    expect(progress).toContain("Add validation");
  });

  test("formatSummary shows final results", async () => {
    const { TaskQueue } = await import("../queue");

    const queue = new TaskQueue(
      ["Fix test", "Add validation"],
      789,
      123456,
      "testuser",
    );

    queue.tasks[0]!.status = "completed";
    queue.tasks[0]!.startedAt = Date.now() - 5000;
    queue.tasks[0]!.completedAt = Date.now();
    queue.tasks[1]!.status = "failed";
    queue.tasks[1]!.error = "Connection timeout";
    queue.tasks[1]!.startedAt = Date.now() - 3000;
    queue.tasks[1]!.completedAt = Date.now();
    queue.completedAt = Date.now();

    const summary = queue.formatSummary();

    expect(summary).toContain("with errors");
    expect(summary).toContain("✅");
    expect(summary).toContain("❌");
    expect(summary).toContain("Connection timeout");
    expect(summary).toContain("1 completed");
    expect(summary).toContain("1 failed");
  });

  test("formatSummary shows cancelled state", async () => {
    const { TaskQueue } = await import("../queue");

    const queue = new TaskQueue(
      ["Fix test", "Add validation"],
      789,
      123456,
      "testuser",
    );

    queue.tasks[0]!.status = "completed";
    queue.tasks[1]!.status = "skipped";
    queue.cancelled = true;
    queue.completedAt = Date.now();

    const summary = queue.formatSummary();

    expect(summary).toContain("Cancelled");
    expect(summary).toContain("⏭️");
  });

  test("formatSummary shows success state", async () => {
    const { TaskQueue } = await import("../queue");

    const queue = new TaskQueue(["Fix test"], 789, 123456, "testuser");

    queue.tasks[0]!.status = "completed";
    queue.completedAt = Date.now();

    const summary = queue.formatSummary();

    expect(summary).toContain("Queue Complete");
    expect(summary).not.toContain("with errors");
    expect(summary).not.toContain("Cancelled");
  });

  test("formatProgress truncates long descriptions", async () => {
    const { TaskQueue } = await import("../queue");

    const longDesc = "A".repeat(100);
    const queue = new TaskQueue([longDesc], 789, 123456, "testuser");

    const progress = queue.formatProgress();

    expect(progress).toContain("...");
    expect(progress).not.toContain("A".repeat(100));
  });

  test("isRunning returns correct state", async () => {
    const { TaskQueue } = await import("../queue");

    const queue = new TaskQueue(["Task 1", "Task 2"], 789, 123456, "testuser");

    // Not started
    expect(queue.isRunning).toBe(false);

    // Running
    queue.currentTaskIndex = 0;
    expect(queue.isRunning).toBe(true);

    // Cancelled
    queue.cancelled = true;
    expect(queue.isRunning).toBe(false);
  });

  test("addTask appends a new pending task", async () => {
    const { TaskQueue } = await import("../queue");

    const queue = new TaskQueue(["Task 1"], 789, 123456, "testuser");
    expect(queue.tasks).toHaveLength(1);

    const idx = queue.addTask("Task 2");

    expect(idx).toBe(1);
    expect(queue.tasks).toHaveLength(2);
    expect(queue.tasks[1]!.description).toBe("Task 2");
    expect(queue.tasks[1]!.status).toBe("pending");
    expect(queue.tasks[1]!.index).toBe(1);
  });

  test("addTask works on a running queue", async () => {
    const { TaskQueue } = await import("../queue");

    const queue = new TaskQueue(
      ["Task 1", "Task 2"],
      789,
      123456,
      "testuser",
    );

    queue.tasks[0]!.status = "completed";
    queue.currentTaskIndex = 1;
    queue.tasks[1]!.status = "running";

    queue.addTask("Task 3");
    queue.addTask("Task 4");

    expect(queue.tasks).toHaveLength(4);
    expect(queue.tasks[2]!.status).toBe("pending");
    expect(queue.tasks[3]!.status).toBe("pending");
    // isRunning should still be true since currentTaskIndex < tasks.length
    expect(queue.isRunning).toBe(true);
  });
});

// ============== /queue Command Tests ==============

describe("commands: /queue", () => {
  beforeEach(resetMocks);

  test("handleQueue returns unauthorized for non-allowed user", async () => {
    const { handleQueue } = await import("../handlers/commands");
    const ctx = createMockContext({
      userId: 999999,
      messageText: "/queue\n1. Fix test",
    });

    await handleQueue(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Unauthorized");
  });

  test("handleQueue shows usage when no tasks provided", async () => {
    const { handleQueue } = await import("../handlers/commands");
    const ctx = createMockContext({
      userId: 123456,
      messageText: "/queue",
    });

    await handleQueue(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Task Queue");
    expect(ctx._replies[0]?.text).toContain("/queue");
  });

  test("handleQueue rejects when session is busy", async () => {
    const { handleQueue } = await import("../handlers/commands");
    mockSessionState.isRunning = true;
    const ctx = createMockContext({
      userId: 123456,
      messageText: "/queue\n1. Fix test",
    });

    await handleQueue(ctx as any);

    expect(ctx._replies[0]?.text).toContain("busy");
  });

  test("handleQueue rejects empty task list", async () => {
    const { handleQueue } = await import("../handlers/commands");
    const ctx = createMockContext({
      userId: 123456,
      messageText: "/queue   ",
    });

    await handleQueue(ctx as any);

    // Shows usage since body is empty
    expect(ctx._replies[0]?.text).toContain("Task Queue");
  });

  test("handleQueue rejects too many tasks", async () => {
    const { handleQueue } = await import("../handlers/commands");
    const tasks = Array.from(
      { length: 25 },
      (_, i) => `${i + 1}. Task ${i + 1}`,
    ).join("\n");
    const ctx = createMockContext({
      userId: 123456,
      messageText: `/queue\n${tasks}`,
    });

    await handleQueue(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Too many tasks");
  });

  test("handleQueue accepts valid task list", async () => {
    const { handleQueue } = await import("../handlers/commands");
    const ctx = createMockContext({
      userId: 123456,
      messageText: "/queue\n1. Fix test\n2. Add validation",
    });

    await handleQueue(ctx as any);

    // Should not show error (queue starts processing)
    const errorReplies = ctx._replies.filter(
      (r) => r.text.includes("Unauthorized") || r.text.includes("Too many"),
    );
    expect(errorReplies).toHaveLength(0);
  });
});

// ============== getActiveQueue Tests ==============

describe("queue: getActiveQueue", () => {
  test("returns null when no queue is active", async () => {
    const { getActiveQueue } = await import("../queue");

    expect(getActiveQueue()).toBeNull();
  });
});
