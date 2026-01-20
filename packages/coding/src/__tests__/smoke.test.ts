/**
 * Smoke tests for bot lifecycle.
 *
 * High-level tests to verify basic functionality doesn't break.
 * These protect against breaking changes during refactoring.
 */

import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from "bun:test";

// Mock grammy before importing bot
const mockBot = {
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

// Mock handlers to avoid complex dependencies
mock.module("../handlers", () => ({
  handleStart: mock(() => {}),
  handleHelp: mock(() => {}),
  handleNew: mock(() => {}),
  handleStop: mock(() => {}),
  handleStatus: mock(() => {}),
  handleRestart: mock(() => {}),
  handleRetry: mock(() => {}),
  handleList: mock(() => {}),
  handleSwitch: mock(() => {}),
  handleRefresh: mock(() => {}),
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
      (call: unknown[]) => call[0]
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
      (call: unknown[]) => call[0]
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
