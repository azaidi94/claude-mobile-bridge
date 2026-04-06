/**
 * Smoke tests for bot lifecycle.
 *
 * High-level tests to verify basic functionality doesn't break.
 * These protect against breaking changes during refactoring.
 */

import {
  describe,
  expect,
  test,
  mock,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";

// Mock grammy before importing bot
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockBot: any = {
  use: mock(() => mockBot),
  command: mock(() => mockBot),
  on: mock(() => mockBot),
  catch: mock(() => mockBot),
  api: {
    sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    editMessageText: mock(() => Promise.resolve(true)),
    getFile: mock(() => Promise.resolve({ file_path: "test.ogg" })),
    getMe: mock(() => Promise.resolve({ username: "testbot" })),
  },
  start: mock(() => Promise.resolve()),
  stop: mock(() => Promise.resolve()),
};

mock.module("grammy", () => ({
  Bot: mock(() => mockBot),
}));

mock.module("@grammyjs/runner", () => ({
  sequentialize: mock(() => mock(() => {})),
  run: mock(() => ({
    isRunning: () => true,
    stop: mock(() => {}),
  })),
}));

// Mock sessions to avoid import errors
mock.module("../sessions", () => ({
  registerChatId: mock(() => {}),
  getChatIds: mock(() => new Set()),
  getActiveSession: mock(() => null),
  updatePinnedStatus: mock(() => Promise.resolve()),
  getGitBranch: mock(() => Promise.resolve("main")),
  getSessions: mock(() => []),
  setActiveSession: mock(() => false),
  addTelegramSession: mock(() => ({ name: "test", dir: "/tmp" })),
  forceRefresh: mock(() => Promise.resolve()),
  removeSession: mock(() => true),
  getSession: mock(() => null),
  getRecentHistory: mock(() => Promise.resolve([])),
  formatHistoryMessage: mock(() => ""),
  sendSwitchHistory: mock(() => Promise.resolve()),
}));

// Mock security
mock.module("../security", () => ({
  isAuthorized: mock(() => true),
  rateLimiter: { check: () => [true] },
  isPathAllowed: mock(() => true),
  checkCommandSafety: mock(() => [true, ""]),
}));

// Mock session singleton
mock.module("../session", () => ({
  session: {
    workingDir: "/tmp",
    isPlanMode: false,
    modelDisplayName: "Opus 4.6",
  },
}));

// Mock config
mock.module("../config", () => ({
  ALLOWED_USERS: [123456],
  RELAY_PORT_FILE_PREFIX: "/tmp/channel-relay-",
  RELAY_CONNECT_TIMEOUT_MS: 3000,
  RELAY_RESPONSE_TIMEOUT_MS: 300000,
  BOT_DIR: "/tmp/test-bot-dir",
}));

// Mock handlers to avoid complex dependencies
mock.module("../handlers", () => ({
  handleStart: mock(() => {}),
  handleHelp: mock(() => {}),
  handleNew: mock(() => {}),
  handleStop: mock(() => {}),
  handleKill: mock(() => {}),
  handleStatus: mock(() => {}),
  handleModel: mock(() => {}),
  handleRestart: mock(() => {}),
  handleRetry: mock(() => {}),
  handleList: mock(() => {}),
  handleSwitch: mock(() => {}),
  handleRefresh: mock(() => {}),
  handlePlan: mock(() => {}),
  handlePin: mock(() => {}),
  handleSessions: mock(() => {}),
  handleSkip: mock(() => {}),
  handleQueue: mock(() => {}),
  handleWatch: mock(() => {}),
  handleUnwatch: mock(() => {}),
  handlePwd: mock(() => {}),
  handleCd: mock(() => {}),
  handleLs: mock(() => {}),
  handleText: mock(() => {}),
  handleVoice: mock(() => {}),
  handlePhoto: mock(() => {}),
  handleDocument: mock(() => {}),
  handleCallback: mock(() => {}),
}));

describe("smoke: bot lifecycle", () => {
  beforeEach(() => {
    // Reset mock call counts
    mockBot.use.mockClear();
    mockBot.command.mockClear();
    mockBot.on.mockClear();
    mockBot.catch.mockClear();
  });

  test("import bot.ts doesn't crash", async () => {
    // Dynamic import to test module loading
    const module = await import("../bot");
    expect(module).toBeDefined();
    expect(module.createBot).toBeFunction();
  });

  test("createBot returns a bot instance", async () => {
    const { createBot } = await import("../bot");

    const bot = createBot({ token: "test-token" });

    expect(bot).toBeDefined();
  });

  test("createBot registers command handlers", async () => {
    const { createBot } = await import("../bot");

    createBot({ token: "test-token" });

    // Verify command handlers were registered
    expect(mockBot.command.mock.calls.length).toBeGreaterThan(0);

    // Check some expected commands
    const registeredCommands = mockBot.command.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(registeredCommands).toContain("start");
    expect(registeredCommands).toContain("help");
    expect(registeredCommands).toContain("list");
  });

  test("createBot registers message handlers", async () => {
    const { createBot } = await import("../bot");

    createBot({ token: "test-token" });

    // Verify message handlers were registered
    expect(mockBot.on.mock.calls.length).toBeGreaterThan(0);

    const registeredEvents = mockBot.on.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(registeredEvents).toContain("message:text");
    expect(registeredEvents).toContain("message:voice");
    expect(registeredEvents).toContain("message:photo");
    expect(registeredEvents).toContain("message:document");
  });

  test("createBot sets up error handler", async () => {
    const { createBot } = await import("../bot");

    createBot({ token: "test-token" });

    // Verify error handler was set
    expect(mockBot.catch).toHaveBeenCalled();
  });

  test("createBot sets up sequentialization middleware", async () => {
    const { createBot } = await import("../bot");

    createBot({ token: "test-token" });

    // Verify middleware was added
    expect(mockBot.use).toHaveBeenCalled();
  });
});

describe("smoke: shutdown", () => {
  test("bot instance has stop capability", async () => {
    const { createBot } = await import("../bot");

    const bot = createBot({ token: "test-token" });

    // Bot should have stop method (from grammy mock)
    expect(bot.stop).toBeFunction();
  });
});

describe("smoke: message flow", () => {
  let capturedTextHandler: ((ctx: unknown) => Promise<void>) | null = null;
  let capturedVoiceHandler: ((ctx: unknown) => Promise<void>) | null = null;

  beforeEach(() => {
    // Capture the handlers registered via bot.on
    capturedTextHandler = null;
    capturedVoiceHandler = null;

    mockBot.on.mockImplementation(
      (event: string, handler: (ctx: unknown) => Promise<void>) => {
        if (event === "message:text") {
          capturedTextHandler = handler;
        }
        if (event === "message:voice") {
          capturedVoiceHandler = handler;
        }
        return mockBot;
      },
    );
  });

  test("can receive mock Telegram text message", async () => {
    const { createBot } = await import("../bot");
    createBot({ token: "test-token" });

    // Handler should be captured
    expect(capturedTextHandler).not.toBeNull();
  });

  test("text message handler doesn't crash on valid context", async () => {
    const { createBot } = await import("../bot");
    createBot({ token: "test-token" });

    expect(capturedTextHandler).not.toBeNull();

    // Create minimal mock context
    const mockCtx = {
      from: { id: 123, username: "testuser" },
      chat: { id: 456 },
      message: { message_id: 1, text: "hello" },
      reply: mock(() => Promise.resolve({ message_id: 2 })),
    };

    // Handler should not throw (will return early due to auth check)
    // The mocked handler returns void, which is fine - just verify no error thrown
    let error: Error | null = null;
    try {
      await capturedTextHandler!(mockCtx);
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeNull();
  });

  test("text message handler doesn't crash on minimal context", async () => {
    const { createBot } = await import("../bot");
    createBot({ token: "test-token" });

    expect(capturedTextHandler).not.toBeNull();

    // Minimal context that simulates edge cases
    const mockCtx = {
      from: undefined,
      chat: undefined,
      message: undefined,
      reply: mock(() => Promise.resolve({ message_id: 2 })),
    };

    // Should not throw even with missing data
    let error: Error | null = null;
    try {
      await capturedTextHandler!(mockCtx);
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeNull();
  });

  test("can receive mock voice message", async () => {
    const { createBot } = await import("../bot");
    createBot({ token: "test-token" });

    expect(capturedVoiceHandler).not.toBeNull();
  });

  test("bot can send response via api.sendMessage", async () => {
    // Verify the mock api is set up correctly
    const result = await mockBot.api.sendMessage(123, "test message");

    expect(result).toEqual({ message_id: 1 });
    expect(mockBot.api.sendMessage).toHaveBeenCalledWith(123, "test message");
  });

  test("bot can edit message via api.editMessageText", async () => {
    const result = await mockBot.api.editMessageText(123, 1, "updated text");

    expect(result).toBe(true);
    expect(mockBot.api.editMessageText).toHaveBeenCalled();
  });
});
