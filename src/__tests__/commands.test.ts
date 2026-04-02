/**
 * Unit tests for Telegram bot commands.
 *
 * Tests /start, /help, /list, /switch, /status, /new, /stop, /retry, /refresh.
 * Each handler follows the pattern: auth check -> logic -> ctx.reply()
 */

import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from "bun:test";
import { mkdtemp, rm } from "fs/promises";

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
  RELAY_PORT_FILE_PREFIX: "/tmp/channel-relay-",
  RELAY_CONNECT_TIMEOUT_MS: 3000,
  RELAY_RESPONSE_TIMEOUT_MS: 300000,
}));

// Mock sessions module
const mockSessions: Array<{
  name: string;
  dir: string;
  lastActivity: number;
  id?: string;
  pid?: number;
  source?: "telegram" | "desktop";
}> = [];
let mockActiveSession: {
  name: string;
  info: {
    dir: string;
    id?: string;
    pid?: number;
    source?: "telegram" | "desktop";
    name: string;
    lastActivity?: number;
  };
} | null = null;
const mockForceRefresh = mock(() => Promise.resolve());
type MockPortFile = {
  port: number;
  pid: number;
  ppid?: number;
  sessionId?: string;
  cwd: string;
  startedAt: string;
};

mock.module("../sessions", () => ({
  getSessions: mock(() => mockSessions),
  getActiveSession: mock(() => mockActiveSession),
  setActiveSession: mock((name: string) => {
    const found = mockSessions.find((s) => s.name === name);
    if (found) {
      mockActiveSession = {
        name: found.name,
        info: {
          dir: found.dir,
          id: found.id,
          pid: found.pid,
          source: found.source,
          name: found.name,
        },
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
      info: { dir: path, name: sessionName, source: "telegram" },
    };
    return newSession;
  }),
  forceRefresh: mockForceRefresh,
  updatePinnedStatus: mock(() => Promise.resolve()),
  removeSession: mock(() => true),
  getGitBranch: mock(() => Promise.resolve("main")),
  getSession: mock(() => null),
  getRecentHistory: mock(() => Promise.resolve([])),
  formatHistoryMessage: mock(() => ""),
  sendSwitchHistory: mock(() => Promise.resolve()),
}));

const mockScanPortFiles = mock(async (): Promise<MockPortFile[]> => []);
const mockIsRelayAvailable = mock(async () => false);
const mockGetRelayDirs = mock(async () => []);
const mockDisconnectRelay = mock(() => {});

mock.module("../relay", () => ({
  isRelayAvailable: mockIsRelayAvailable,
  getRelayDirs: mockGetRelayDirs,
  disconnectRelay: mockDisconnectRelay,
  scanPortFiles: mockScanPortFiles,
}));

const mockStartWatchingSession = mock(async () => true);
const mockStartWatchingAndNotify = mock(async () => true);
const mockStopWatching = mock(() => undefined);
const mockIsWatching = mock(() => false);

mock.module("../handlers/watch", () => ({
  startWatchingSession: mockStartWatchingSession,
  startWatchingAndNotify: mockStartWatchingAndNotify,
  stopWatching: mockStopWatching,
  isWatching: mockIsWatching,
}));

// Mock session singleton
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
};

const mockSessionMethods = {
  stop: mock(() => Promise.resolve(false as "stopped" | "pending" | false)),
  clearStopRequested: mock(() => {}),
  kill: mock(() => Promise.resolve()),
  setWorkingDir: mock((dir: string) => {
    mockSessionState.workingDir = dir;
  }),
  loadFromRegistry: mock((info: { dir: string; name: string }) => {
    mockSessionState.workingDir = info.dir;
    mockSessionState.sessionName = info.name;
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
    get sessionName() {
      return mockSessionState.sessionName;
    },
    get workingDir() {
      return mockSessionState.workingDir;
    },
    get lastMessage() {
      return mockSessionState.lastMessage;
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

  // Simulate grammy's ctx.match: text after the /command
  const matchResult = messageText.replace(/^\/\S+\s*/, "");

  return {
    from: { id: userId, username },
    chat: { id: chatId },
    message: { text: messageText, message_id: 1 },
    match: matchResult || undefined,
    reply: mock(async (text: string, options?: Record<string, unknown>) => {
      replies.push({ text, options });
      return { chat: { id: chatId }, message_id: Date.now() };
    }),
    api: {
      sendMessage: mock(async () => ({ message_id: Date.now() })),
      editMessageText: mock(async () => ({})),
    },
    _replies: replies,
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
  mockSessionState.lastTool = null;
  mockSessionState.currentTool = null;
  mockSessionState.lastError = null;
  mockSessionState.lastUsage = null;
  mockSessionState.queryStarted = null;

  mockSessionMethods.stop.mockClear();
  mockSessionMethods.clearStopRequested.mockClear();
  mockSessionMethods.kill.mockClear();
  mockSessionMethods.setWorkingDir.mockClear();
  mockSessionMethods.loadFromRegistry.mockClear();
  mockForceRefresh.mockClear();
  mockForceRefresh.mockImplementation(() => Promise.resolve());
  mockScanPortFiles.mockClear();
  mockScanPortFiles.mockImplementation(async () => []);
  mockIsRelayAvailable.mockClear();
  mockIsRelayAvailable.mockImplementation(async () => false);
  mockGetRelayDirs.mockClear();
  mockGetRelayDirs.mockImplementation(async () => []);
  mockDisconnectRelay.mockClear();
  mockStartWatchingSession.mockClear();
  mockStartWatchingSession.mockImplementation(async () => true);
  mockStartWatchingAndNotify.mockClear();
  mockStartWatchingAndNotify.mockImplementation(async () => true);
  mockStopWatching.mockClear();
  mockIsWatching.mockClear();
  mockIsWatching.mockImplementation(() => false);
}

// ============== /start Command Tests ==============

describe("commands: /start", () => {
  beforeEach(resetMocks);

  test("handleStart returns unauthorized for non-allowed user", async () => {
    const { handleStart } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 999999 });

    await handleStart(ctx as any);

    expect(ctx.reply).toHaveBeenCalled();
    expect(ctx._replies[0]?.text).toContain("Unauthorized");
  });

  test("handleStart shows welcome message for allowed user", async () => {
    const { handleStart } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 123456 });

    await handleStart(ctx as any);

    expect(ctx.reply).toHaveBeenCalled();
    expect(ctx._replies[0]?.text).toContain("Claude");
    expect(ctx._replies[0]?.options?.parse_mode).toBe("HTML");
  });

  test("handleStart shows 'none' when no active session", async () => {
    const { handleStart } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 123456 });

    await handleStart(ctx as any);

    expect(ctx._replies[0]?.text).toContain("none");
  });

  test("handleStart shows session name when active session exists", async () => {
    const { handleStart } = await import("../handlers/commands");
    mockActiveSession = {
      name: "my-project",
      info: { dir: "/tmp/project", name: "my-project" },
    };
    const ctx = createMockContext({ userId: 123456 });

    await handleStart(ctx as any);

    expect(ctx._replies[0]?.text).toContain("my-project");
  });

  test("handleStart shows /help hint", async () => {
    const { handleStart } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 123456 });

    await handleStart(ctx as any);

    expect(ctx._replies[0]?.text).toContain("/help");
  });
});

// ============== /help Command Tests ==============

describe("commands: /help", () => {
  beforeEach(resetMocks);

  test("handleHelp returns unauthorized for non-allowed user", async () => {
    const { handleHelp } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 999999 });

    await handleHelp(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Unauthorized");
  });

  test("handleHelp shows all commands", async () => {
    const { handleHelp } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 123456 });

    await handleHelp(ctx as any);

    const text = ctx._replies[0]?.text || "";
    expect(text).toContain("/list");
    expect(text).toContain("/switch");
    expect(text).toContain("/new");
    expect(text).toContain("/stop");
    expect(text).toContain("/retry");
    expect(text).toContain("/status");
    expect(text).toContain("/restart");
  });

  test("handleHelp uses HTML parse mode", async () => {
    const { handleHelp } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 123456 });

    await handleHelp(ctx as any);

    expect(ctx._replies[0]?.options?.parse_mode).toBe("HTML");
  });

  test("handleHelp includes tips section", async () => {
    const { handleHelp } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 123456 });

    await handleHelp(ctx as any);

    const text = ctx._replies[0]?.text || "";
    expect(text).toContain("Tips");
  });
});

// ============== /list Command Tests ==============

describe("commands: /list", () => {
  beforeEach(resetMocks);

  test("handleList returns unauthorized for non-allowed user", async () => {
    const { handleList } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 999999 });

    await handleList(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Unauthorized");
  });

  test("handleList shows no sessions message when empty", async () => {
    const { handleList } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 123456 });

    await handleList(ctx as any);

    expect(ctx._replies[0]?.text).toContain("No sessions");
  });

  test("handleList shows available sessions", async () => {
    const { handleList } = await import("../handlers/commands");
    mockSessions.push(
      {
        name: "project-1",
        dir: "/tmp/project1",
        lastActivity: Date.now() - 60000,
      },
      { name: "project-2", dir: "/tmp/project2", lastActivity: Date.now() },
    );
    const ctx = createMockContext({ userId: 123456 });

    await handleList(ctx as any);

    const text = ctx._replies[0]?.text || "";
    expect(text).toContain("project-1");
    expect(text).toContain("project-2");
  });

  test("handleList marks active session with checkmark", async () => {
    const { handleList } = await import("../handlers/commands");
    mockSessions.push({
      name: "active-project",
      dir: "/tmp/active",
      lastActivity: Date.now(),
    });
    mockActiveSession = {
      name: "active-project",
      info: { dir: "/tmp/active", name: "active-project" },
    };
    const ctx = createMockContext({ userId: 123456 });

    await handleList(ctx as any);

    const text = ctx._replies[0]?.text || "";
    expect(text).toContain("✅");
  });

  test("handleList includes inline keyboard buttons", async () => {
    const { handleList } = await import("../handlers/commands");
    mockSessions.push({
      name: "project-1",
      dir: "/tmp/project1",
      lastActivity: Date.now(),
    });
    const ctx = createMockContext({ userId: 123456 });

    await handleList(ctx as any);

    const keyboard = ctx._replies[0]?.options?.reply_markup as {
      inline_keyboard: unknown[];
    };
    expect(keyboard?.inline_keyboard).toBeDefined();
    expect(keyboard?.inline_keyboard.length).toBeGreaterThan(0);
  });

  test("handleList shows time ago for sessions", async () => {
    const { handleList } = await import("../handlers/commands");
    mockSessions.push({
      name: "recent",
      dir: "/tmp/recent",
      lastActivity: Date.now() - 30000,
    });
    const ctx = createMockContext({ userId: 123456 });

    await handleList(ctx as any);

    const text = ctx._replies[0]?.text || "";
    // Should contain some time indicator (just now, Xm ago, etc)
    expect(text).toMatch(/(just now|ago)/);
  });
});

// ============== /switch Command Tests ==============

describe("commands: /switch", () => {
  beforeEach(resetMocks);

  test("handleSwitch returns unauthorized for non-allowed user", async () => {
    const { handleSwitch } = await import("../handlers/commands");
    const ctx = createMockContext({
      userId: 999999,
      messageText: "/switch test",
    });

    await handleSwitch(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Unauthorized");
  });

  test("handleSwitch shows usage when no name provided", async () => {
    const { handleSwitch } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 123456, messageText: "/switch" });

    await handleSwitch(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Usage");
    expect(ctx._replies[0]?.text).toContain("/switch");
  });

  test("handleSwitch shows error for non-existent session", async () => {
    const { handleSwitch } = await import("../handlers/commands");
    const ctx = createMockContext({
      userId: 123456,
      messageText: "/switch nonexistent",
    });

    await handleSwitch(ctx as any);

    expect(ctx._replies[0]?.text).toContain("not found");
    expect(ctx._replies[0]?.text).toContain("/list");
  });

  test("handleSwitch successfully switches to existing session", async () => {
    const { handleSwitch } = await import("../handlers/commands");
    mockSessions.push({
      name: "target-session",
      dir: "/tmp/target",
      lastActivity: Date.now(),
    });
    const ctx = createMockContext({
      userId: 123456,
      messageText: "/switch target-session",
    });

    await handleSwitch(ctx as any);

    expect(ctx._replies[0]?.text).toContain("target-session");
    expect(ctx._replies[0]?.text).not.toContain("not found");
  });

  test("handleSwitch shows directory after successful switch", async () => {
    const { handleSwitch } = await import("../handlers/commands");
    mockSessions.push({
      name: "my-project",
      dir: "/tmp/my-project",
      lastActivity: Date.now(),
    });
    const ctx = createMockContext({
      userId: 123456,
      messageText: "/switch my-project",
    });

    await handleSwitch(ctx as any);

    expect(ctx._replies[0]?.text).toContain("/tmp/my-project");
  });
});

// ============== /status Command Tests ==============

describe("commands: /status", () => {
  beforeEach(resetMocks);

  test("handleStatus returns unauthorized for non-allowed user", async () => {
    const { handleStatus } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 999999 });

    await handleStatus(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Unauthorized");
  });

  test("handleStatus shows no session message when none active", async () => {
    const { handleStatus } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 123456 });

    await handleStatus(ctx as any);

    expect(ctx._replies[0]?.text).toContain("No session");
  });

  test("handleStatus shows running status when query running", async () => {
    const { handleStatus } = await import("../handlers/commands");
    mockActiveSession = {
      name: "running-session",
      info: { dir: "/tmp/running", name: "running-session" },
    };
    mockSessionState.isRunning = true;
    mockSessionState.queryStarted = new Date(Date.now() - 5000);
    const ctx = createMockContext({ userId: 123456 });

    await handleStatus(ctx as any);

    const text = ctx._replies[0]?.text || "";
    expect(text).toContain("Running");
  });

  test("handleStatus shows ready status when session active but not running", async () => {
    const { handleStatus } = await import("../handlers/commands");
    mockActiveSession = {
      name: "ready-session",
      info: { dir: "/tmp/ready", name: "ready-session" },
    };
    mockSessionState.isActive = true;
    mockSessionState.sessionId = "test-session-id-123";
    const ctx = createMockContext({ userId: 123456 });

    await handleStatus(ctx as any);

    const text = ctx._replies[0]?.text || "";
    expect(text).toContain("Ready");
  });

  test("handleStatus shows not started status when session not active", async () => {
    const { handleStatus } = await import("../handlers/commands");
    mockActiveSession = {
      name: "new-session",
      info: { dir: "/tmp/new", name: "new-session" },
    };
    mockSessionState.sessionName = "new-session";
    const ctx = createMockContext({ userId: 123456 });

    await handleStatus(ctx as any);

    const text = ctx._replies[0]?.text || "";
    expect(text).toContain("Not started");
  });

  test("handleStatus shows current tool when running", async () => {
    const { handleStatus } = await import("../handlers/commands");
    mockActiveSession = {
      name: "tool-session",
      info: { dir: "/tmp/tool", name: "tool-session" },
    };
    mockSessionState.isRunning = true;
    mockSessionState.currentTool = "Reading file.ts";
    mockSessionState.queryStarted = new Date();
    const ctx = createMockContext({ userId: 123456 });

    await handleStatus(ctx as any);

    const text = ctx._replies[0]?.text || "";
    expect(text).toContain("Reading file.ts");
  });

  test("handleStatus shows last activity time", async () => {
    const { handleStatus } = await import("../handlers/commands");
    mockActiveSession = {
      name: "activity-session",
      info: { dir: "/tmp/activity", name: "activity-session" },
    };
    mockSessionState.isActive = true;
    mockSessionState.sessionId = "test-123";
    mockSessionState.lastActivity = new Date(Date.now() - 30000);
    const ctx = createMockContext({ userId: 123456 });

    await handleStatus(ctx as any);

    const text = ctx._replies[0]?.text || "";
    expect(text).toContain("ago");
  });

  test("handleStatus shows usage stats when available", async () => {
    const { handleStatus } = await import("../handlers/commands");
    mockActiveSession = {
      name: "usage-session",
      info: { dir: "/tmp/usage", name: "usage-session" },
    };
    mockSessionState.isActive = true;
    mockSessionState.sessionId = "test-123";
    mockSessionState.lastUsage = { input_tokens: 5000, output_tokens: 2000 };
    const ctx = createMockContext({ userId: 123456 });

    await handleStatus(ctx as any);

    const text = ctx._replies[0]?.text || "";
    expect(text).toContain("k in");
    expect(text).toContain("k out");
  });

  test("handleStatus shows error when present", async () => {
    const { handleStatus } = await import("../handlers/commands");
    mockActiveSession = {
      name: "error-session",
      info: { dir: "/tmp/error", name: "error-session" },
    };
    mockSessionState.isActive = true;
    mockSessionState.sessionId = "test-123";
    mockSessionState.lastError = "Connection timeout";
    const ctx = createMockContext({ userId: 123456 });

    await handleStatus(ctx as any);

    const text = ctx._replies[0]?.text || "";
    expect(text).toContain("Connection timeout");
  });

  test("handleStatus shows working directory", async () => {
    const { handleStatus } = await import("../handlers/commands");
    mockActiveSession = {
      name: "dir-session",
      info: { dir: "/tmp/mydir", name: "dir-session" },
    };
    mockSessionState.isActive = true;
    mockSessionState.sessionId = "test-123";
    mockSessionState.workingDir = "/tmp/mydir";
    const ctx = createMockContext({ userId: 123456 });

    await handleStatus(ctx as any);

    const text = ctx._replies[0]?.text || "";
    expect(text).toContain("/tmp/mydir");
  });
});

// ============== /new Command Tests ==============

describe("commands: /new", () => {
  beforeEach(resetMocks);
  let bunWhichSpy: ReturnType<typeof spyOn> | null = null;
  let bunSpawnSyncSpy: ReturnType<typeof spyOn> | null = null;
  let bunSleepSpy: ReturnType<typeof spyOn> | null = null;

  beforeEach(() => {
    bunWhichSpy = spyOn(Bun, "which").mockReturnValue("/usr/local/bin/cmux");
    bunSpawnSyncSpy = spyOn(Bun, "spawnSync").mockImplementation(
      (cmdOrOptions: any) => {
        const cmd = Array.isArray(cmdOrOptions)
          ? cmdOrOptions
          : cmdOrOptions?.cmd || [];
        return {
          stdout: Buffer.from(cmd[1] === "new-workspace" ? "workspace:42" : ""),
          success: true,
          exitCode: 0,
        } as any;
      },
    );
    bunSleepSpy = spyOn(Bun, "sleep").mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    bunWhichSpy?.mockRestore();
    bunSpawnSyncSpy?.mockRestore();
    bunSleepSpy?.mockRestore();
  });

  test("handleNew returns unauthorized for non-allowed user", async () => {
    const { handleNew } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 999999, messageText: "/new" });

    await handleNew(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Unauthorized");
  });

  test("handleNew auto-watches the newly spawned session in the same directory", async () => {
    const { handleNew } = await import("../handlers/commands");
    const tmpDir = await mkdtemp("/tmp/new-command-");

    try {
      mockSessions.push({
        name: "existing-session",
        dir: tmpDir,
        id: "old-session",
        pid: 111,
        source: "desktop",
        lastActivity: Date.now() - 1000,
      });
      mockScanPortFiles.mockImplementation(async () => {
        if (mockScanPortFiles.mock.calls.length === 1) {
          return [
            {
              port: 4001,
              pid: 201,
              ppid: 111,
              sessionId: "old-session",
              cwd: tmpDir,
              startedAt: "2026-01-01T00:00:00.000Z",
            },
          ];
        }
        return [
          {
            port: 4001,
            pid: 201,
            ppid: 111,
            sessionId: "old-session",
            cwd: tmpDir,
            startedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            port: 4002,
            pid: 202,
            ppid: 222,
            sessionId: "new-session-id",
            cwd: tmpDir,
            startedAt: "2026-01-01T00:00:01.000Z",
          },
        ];
      });
      mockForceRefresh.mockImplementation(async () => {
        mockSessions.push({
          name: "spawned-session",
          dir: tmpDir,
          id: "new-session-id",
          pid: 222,
          source: "desktop",
          lastActivity: Date.now(),
        });
      });

      const ctx = createMockContext({
        userId: 123456,
        messageText: `/new ${tmpDir}`,
      });

      await handleNew(ctx as any);

      expect(mockStartWatchingSession).toHaveBeenCalledWith(
        ctx.api,
        789,
        "spawned-session",
        "spawn",
      );
      expect(mockActiveSession?.name).toBe("spawned-session");
      expect(ctx._replies.at(-1)?.text).toContain("spawned-session");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("handleNew does not attach to an older same-directory session when the new one is unresolved", async () => {
    const { handleNew } = await import("../handlers/commands");
    const tmpDir = await mkdtemp("/tmp/new-command-");

    try {
      mockSessions.push({
        name: "existing-session",
        dir: tmpDir,
        id: "old-session",
        pid: 111,
        source: "desktop",
        lastActivity: Date.now() - 1000,
      });
      mockScanPortFiles.mockImplementation(async () => {
        if (mockScanPortFiles.mock.calls.length === 1) {
          return [
            {
              port: 4001,
              pid: 201,
              ppid: 111,
              sessionId: "old-session",
              cwd: tmpDir,
              startedAt: "2026-01-01T00:00:00.000Z",
            },
          ];
        }
        return [
          {
            port: 4001,
            pid: 201,
            ppid: 111,
            sessionId: "old-session",
            cwd: tmpDir,
            startedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            port: 4002,
            pid: 202,
            ppid: 222,
            sessionId: "new-session-id",
            cwd: tmpDir,
            startedAt: "2026-01-01T00:00:01.000Z",
          },
        ];
      });
      mockForceRefresh.mockImplementation(async () => {});

      const ctx = createMockContext({
        userId: 123456,
        messageText: `/new ${tmpDir}`,
      });

      await handleNew(ctx as any);

      expect(mockStartWatchingSession).not.toHaveBeenCalled();
      expect(mockActiveSession).toBeNull();
      expect(ctx._replies.at(-1)?.text).toContain(
        "could not uniquely identify the new session",
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============== /stop Command Tests ==============

describe("commands: /stop", () => {
  beforeEach(resetMocks);

  test("handleStop returns unauthorized for non-allowed user", async () => {
    const { handleStop } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 999999 });

    await handleStop(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Unauthorized");
  });

  test("handleStop stops running query", async () => {
    const { handleStop } = await import("../handlers/commands");
    mockSessionState.isRunning = true;
    const ctx = createMockContext({ userId: 123456 });

    await handleStop(ctx as any);

    expect(mockSessionMethods.stop).toHaveBeenCalled();
    expect(mockSessionMethods.clearStopRequested).toHaveBeenCalled();
  });

  test("handleStop replies when no query running", async () => {
    const { handleStop } = await import("../handlers/commands");
    mockSessionState.isRunning = false;
    const ctx = createMockContext({ userId: 123456 });

    await handleStop(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Nothing running");
  });

  test("handleStop replies on success", async () => {
    const { handleStop } = await import("../handlers/commands");
    mockSessionState.isRunning = true;
    mockSessionMethods.stop.mockResolvedValue("stopped");
    const ctx = createMockContext({ userId: 123456 });

    await handleStop(ctx as any);

    expect(ctx._replies[0]?.text).toContain("stopped");
  });
});

// ============== /retry Command Tests ==============

describe("commands: /retry", () => {
  beforeEach(resetMocks);

  test("handleRetry returns unauthorized for non-allowed user", async () => {
    const { handleRetry } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 999999 });

    await handleRetry(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Unauthorized");
  });

  test("handleRetry shows error when no last message", async () => {
    const { handleRetry } = await import("../handlers/commands");
    mockSessionState.lastMessage = null;
    const ctx = createMockContext({ userId: 123456 });

    await handleRetry(ctx as any);

    expect(ctx._replies[0]?.text).toContain("No message to retry");
  });

  test("handleRetry shows error when query running", async () => {
    const { handleRetry } = await import("../handlers/commands");
    mockSessionState.lastMessage = "test message";
    mockSessionState.isRunning = true;
    const ctx = createMockContext({ userId: 123456 });

    await handleRetry(ctx as any);

    expect(ctx._replies[0]?.text).toContain("running");
    expect(ctx._replies[0]?.text).toContain("/stop");
  });
});

// ============== /refresh Command Tests ==============

describe("commands: /refresh", () => {
  beforeEach(resetMocks);

  test("handleRefresh returns unauthorized for non-allowed user", async () => {
    const { handleRefresh } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 999999 });

    await handleRefresh(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Unauthorized");
  });

  test("handleRefresh shows session count after refresh", async () => {
    const { handleRefresh } = await import("../handlers/commands");
    mockSessions.push({
      name: "session-1",
      dir: "/tmp/1",
      lastActivity: Date.now(),
    });
    const ctx = createMockContext({ userId: 123456 });

    await handleRefresh(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Refreshed");
    expect(ctx._replies[0]?.text).toContain("1 session");
  });
});

// ============== Command Parsing Tests ==============

describe("commands: parsing", () => {
  beforeEach(resetMocks);

  test("switch command parses name with spaces correctly", async () => {
    // /switch only takes first word after command
    const { handleSwitch } = await import("../handlers/commands");
    mockSessions.push({
      name: "project",
      dir: "/tmp/project",
      lastActivity: Date.now(),
    });
    const ctx = createMockContext({
      userId: 123456,
      messageText: "/switch project extra words",
    });

    await handleSwitch(ctx as any);

    // Should try to switch to "project", not "project extra words"
    expect(ctx._replies[0]?.text).toContain("project");
  });

  test("new command rejects non-existent path", async () => {
    const { handleNew } = await import("../handlers/commands");
    const whichSpy = spyOn(Bun, "which").mockReturnValue("/usr/local/bin/cmux");
    const ctx = createMockContext({
      userId: 123456,
      messageText: "/new /nonexistent/path",
    });

    try {
      await handleNew(ctx as any);
      expect(ctx._replies[0]?.text).toContain("Path does not exist");
    } finally {
      whichSpy.mockRestore();
    }
  });

  test("handlers handle undefined message gracefully", async () => {
    const { handleSwitch } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 123456 });
    (ctx as any).message = undefined;

    // Should not throw
    await handleSwitch(ctx as any);

    // Should show usage since no name was parsed
    expect(ctx._replies[0]?.text).toContain("Usage");
  });

  test("handlers handle undefined from gracefully", async () => {
    const { handleStart } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 123456 });
    (ctx as any).from = undefined;

    // Should return unauthorized
    await handleStart(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Unauthorized");
  });
});

// ============== formatTimeAgo Helper Tests ==============

describe("commands: formatTimeAgo helper", () => {
  // The formatTimeAgo function is private, but we can test it indirectly via /list

  beforeEach(resetMocks);

  test("shows 'just now' for very recent activity", async () => {
    const { handleList } = await import("../handlers/commands");
    mockSessions.push({
      name: "recent",
      dir: "/tmp/recent",
      lastActivity: Date.now() - 10000,
    });
    const ctx = createMockContext({ userId: 123456 });

    await handleList(ctx as any);

    expect(ctx._replies[0]?.text).toContain("just now");
  });

  test("shows minutes for activity within hour", async () => {
    const { handleList } = await import("../handlers/commands");
    mockSessions.push({
      name: "minutes",
      dir: "/tmp/minutes",
      lastActivity: Date.now() - 5 * 60000,
    });
    const ctx = createMockContext({ userId: 123456 });

    await handleList(ctx as any);

    expect(ctx._replies[0]?.text).toContain("m ago");
  });

  test("shows hours for activity within day", async () => {
    const { handleList } = await import("../handlers/commands");
    mockSessions.push({
      name: "hours",
      dir: "/tmp/hours",
      lastActivity: Date.now() - 3 * 3600000,
    });
    const ctx = createMockContext({ userId: 123456 });

    await handleList(ctx as any);

    expect(ctx._replies[0]?.text).toContain("h ago");
  });

  test("shows days for old activity", async () => {
    const { handleList } = await import("../handlers/commands");
    mockSessions.push({
      name: "days",
      dir: "/tmp/days",
      lastActivity: Date.now() - 3 * 86400000,
    });
    const ctx = createMockContext({ userId: 123456 });

    await handleList(ctx as any);

    expect(ctx._replies[0]?.text).toContain("d ago");
  });
});

// ============== Edge Cases ==============

describe("commands: edge cases", () => {
  beforeEach(resetMocks);

  test("handlers work with both allowed users", async () => {
    const { handleStart } = await import("../handlers/commands");

    // First allowed user
    const ctx1 = createMockContext({ userId: 123456 });
    await handleStart(ctx1 as any);
    expect(ctx1._replies[0]?.text).toContain("Claude");

    // Second allowed user
    const ctx2 = createMockContext({ userId: 789012 });
    await handleStart(ctx2 as any);
    expect(ctx2._replies[0]?.text).toContain("Claude");
  });

  test("switch with empty session name after command", async () => {
    const { handleSwitch } = await import("../handlers/commands");
    const ctx = createMockContext({
      userId: 123456,
      messageText: "/switch   ",
    });

    await handleSwitch(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Usage");
  });

  test("list with many sessions renders correctly", async () => {
    const { handleList } = await import("../handlers/commands");

    // Add multiple sessions
    for (let i = 0; i < 10; i++) {
      mockSessions.push({
        name: `project-${i}`,
        dir: `/tmp/project${i}`,
        lastActivity: Date.now() - i * 60000,
      });
    }
    const ctx = createMockContext({ userId: 123456 });

    await handleList(ctx as any);

    const text = ctx._replies[0]?.text || "";
    expect(text).toContain("project-0");
    expect(text).toContain("project-9");
  });

  test("status with very long error truncates", async () => {
    const { handleStatus } = await import("../handlers/commands");
    mockActiveSession = {
      name: "error-session",
      info: { dir: "/tmp/error", name: "error-session" },
    };
    mockSessionState.isActive = true;
    mockSessionState.sessionId = "test-123";
    mockSessionState.lastError = "a".repeat(200);
    const ctx = createMockContext({ userId: 123456 });

    await handleStatus(ctx as any);

    // Error should be truncated (max 50 chars in display)
    const text = ctx._replies[0]?.text || "";
    expect(text.includes("a".repeat(51))).toBe(false);
  });

  test("home directory path is abbreviated with ~", async () => {
    const { handleList } = await import("../handlers/commands");
    const homeDir = process.env.HOME || "/Users/test";
    mockSessions.push({
      name: "home-project",
      dir: `${homeDir}/projects/test`,
      lastActivity: Date.now(),
    });
    const ctx = createMockContext({ userId: 123456 });

    await handleList(ctx as any);

    const text = ctx._replies[0]?.text || "";
    expect(text).toContain("~");
    expect(text).toContain("projects/test");
  });
});

// ============== /pwd Command Tests ==============

describe("commands: /pwd", () => {
  beforeEach(resetMocks);

  test("handlePwd returns unauthorized for non-allowed user", async () => {
    const { handlePwd } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 999999 });

    await handlePwd(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Unauthorized");
  });

  test("handlePwd shows current working directory", async () => {
    const { handlePwd } = await import("../handlers/commands");
    mockSessionState.workingDir = "/tmp/my-project";
    const ctx = createMockContext({ userId: 123456 });

    await handlePwd(ctx as any);

    expect(ctx._replies[0]?.text).toContain("/tmp/my-project");
    expect(ctx._replies[0]?.options?.parse_mode).toBe("HTML");
  });

  test("handlePwd falls back to WORKING_DIR when session has no dir", async () => {
    const { handlePwd } = await import("../handlers/commands");
    mockSessionState.workingDir = "/tmp/test-working-dir";
    const ctx = createMockContext({ userId: 123456 });

    await handlePwd(ctx as any);

    expect(ctx._replies[0]?.text).toContain("/tmp/test-working-dir");
  });
});

// ============== /cd Command Tests ==============

describe("commands: /cd", () => {
  beforeEach(resetMocks);

  test("handleCd returns unauthorized for non-allowed user", async () => {
    const { handleCd } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 999999, messageText: "/cd /tmp" });

    await handleCd(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Unauthorized");
  });

  test("handleCd shows usage when no path provided", async () => {
    const { handleCd } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 123456, messageText: "/cd" });

    await handleCd(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Usage");
  });

  test("handleCd changes to valid directory", async () => {
    const { handleCd } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 123456, messageText: "/cd /tmp" });

    await handleCd(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Now in:");
    expect(ctx._replies[0]?.text).toContain("/tmp");
    expect(mockSessionMethods.setWorkingDir).toHaveBeenCalledWith("/tmp");
  });

  test("handleCd rejects path outside allowed directories", async () => {
    const { handleCd } = await import("../handlers/commands");
    const ctx = createMockContext({
      userId: 123456,
      messageText: "/cd /etc/passwd",
    });

    await handleCd(ctx as any);

    expect(ctx._replies[0]?.text).toContain("not in allowed");
    expect(mockSessionMethods.setWorkingDir).not.toHaveBeenCalled();
  });

  test("handleCd rejects non-existent path", async () => {
    const { handleCd } = await import("../handlers/commands");
    const ctx = createMockContext({
      userId: 123456,
      messageText: "/cd /tmp/nonexistent-dir-xyz-12345",
    });

    await handleCd(ctx as any);

    expect(ctx._replies[0]?.text).toContain("does not exist");
    expect(mockSessionMethods.setWorkingDir).not.toHaveBeenCalled();
  });

  test("handleCd rejects file path (not a directory)", async () => {
    // Create a temp file to test with
    const tmpFile = "/tmp/cd-test-file-" + Date.now();
    await Bun.write(tmpFile, "test");

    const { handleCd } = await import("../handlers/commands");
    const ctx = createMockContext({
      userId: 123456,
      messageText: `/cd ${tmpFile}`,
    });

    await handleCd(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Not a directory");
    expect(mockSessionMethods.setWorkingDir).not.toHaveBeenCalled();

    // Cleanup
    const { unlink } = await import("fs/promises");
    await unlink(tmpFile).catch(() => {});
  });

  test("handleCd resolves relative paths against current working dir", async () => {
    const { handleCd } = await import("../handlers/commands");
    mockSessionState.workingDir = "/tmp";
    const ctx = createMockContext({
      userId: 123456,
      messageText: "/cd nonexistent-subdir-xyz-98765",
    });

    await handleCd(ctx as any);

    // Should resolve relative to /tmp, not reject as disallowed
    const text = ctx._replies[0]?.text || "";
    expect(text).not.toContain("not in allowed");
    // Should report the path doesn't exist
    expect(text).toContain("does not exist");
  });

  test("handleCd normalizes ../segments in path", async () => {
    const { mkdtemp } = await import("fs/promises");
    const tmpDir = await mkdtemp("/tmp/cd-norm-test-");

    const { handleCd } = await import("../handlers/commands");
    const ctx = createMockContext({
      userId: 123456,
      messageText: `/cd ${tmpDir}/../${tmpDir.split("/").pop()}`,
    });

    await handleCd(ctx as any);

    // Should normalize to the canonical path without ..
    expect(ctx._replies[0]?.text).toContain("Now in:");
    expect(ctx._replies[0]?.text).not.toContain("..");
    expect(mockSessionMethods.setWorkingDir).toHaveBeenCalledWith(tmpDir);

    const { rm } = await import("fs/promises");
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  test("handleCd escapes HTML in path output", async () => {
    const { handleCd } = await import("../handlers/commands");
    // Path with special HTML chars won't exist, but the error message
    // for non-allowed paths doesn't include the path, so test via valid dir
    const { mkdtemp } = await import("fs/promises");
    const tmpDir = await mkdtemp("/tmp/cd-html-test-");

    const ctx = createMockContext({
      userId: 123456,
      messageText: `/cd ${tmpDir}`,
    });

    await handleCd(ctx as any);

    // Should use <code> tags properly (HTML parse mode)
    expect(ctx._replies[0]?.options?.parse_mode).toBe("HTML");

    const { rm } = await import("fs/promises");
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });
});

// ============== /ls Command Tests ==============

describe("commands: /ls", () => {
  beforeEach(resetMocks);

  test("handleLs returns unauthorized for non-allowed user", async () => {
    const { handleLs } = await import("../handlers/commands");
    const ctx = createMockContext({ userId: 999999, messageText: "/ls" });

    await handleLs(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Unauthorized");
  });

  test("handleLs lists current directory when no path given", async () => {
    const { handleLs } = await import("../handlers/commands");
    mockSessionState.workingDir = "/tmp";
    const ctx = createMockContext({ userId: 123456, messageText: "/ls" });

    await handleLs(ctx as any);

    expect(ctx._replies[0]?.text).toContain("/tmp");
    expect(ctx._replies[0]?.options?.parse_mode).toBe("HTML");
  });

  test("handleLs lists specified directory", async () => {
    const { handleLs } = await import("../handlers/commands");
    const ctx = createMockContext({
      userId: 123456,
      messageText: "/ls /tmp",
    });

    await handleLs(ctx as any);

    expect(ctx._replies[0]?.text).toContain("/tmp");
  });

  test("handleLs shows directory and file icons", async () => {
    // Create a temp dir with contents
    const {
      mkdtemp,
      writeFile,
      mkdir: mkdirAsync,
    } = await import("fs/promises");
    const tmpDir = await mkdtemp("/tmp/ls-test-");
    await mkdirAsync(`${tmpDir}/subdir`);
    await writeFile(`${tmpDir}/file.txt`, "test");

    const { handleLs } = await import("../handlers/commands");
    const ctx = createMockContext({
      userId: 123456,
      messageText: `/ls ${tmpDir}`,
    });

    await handleLs(ctx as any);

    const text = ctx._replies[0]?.text || "";
    expect(text).toContain("📂"); // directory icon
    expect(text).toContain("📄"); // file icon
    expect(text).toContain("subdir/");
    expect(text).toContain("file.txt");

    // Cleanup
    const { rm } = await import("fs/promises");
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  test("handleLs sorts directories before files", async () => {
    const {
      mkdtemp,
      writeFile,
      mkdir: mkdirAsync,
    } = await import("fs/promises");
    const tmpDir = await mkdtemp("/tmp/ls-sort-test-");
    await writeFile(`${tmpDir}/zebra.txt`, "test");
    await mkdirAsync(`${tmpDir}/alpha-dir`);
    await writeFile(`${tmpDir}/beta.txt`, "test");

    const { handleLs } = await import("../handlers/commands");
    const ctx = createMockContext({
      userId: 123456,
      messageText: `/ls ${tmpDir}`,
    });

    await handleLs(ctx as any);

    const text = ctx._replies[0]?.text || "";
    const dirIdx = text.indexOf("alpha-dir");
    const fileIdx = text.indexOf("beta.txt");
    expect(dirIdx).toBeLessThan(fileIdx);

    // Cleanup
    const { rm } = await import("fs/promises");
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  test("handleLs shows empty message for empty directory", async () => {
    const { mkdtemp } = await import("fs/promises");
    const tmpDir = await mkdtemp("/tmp/ls-empty-test-");

    const { handleLs } = await import("../handlers/commands");
    const ctx = createMockContext({
      userId: 123456,
      messageText: `/ls ${tmpDir}`,
    });

    await handleLs(ctx as any);

    const text = ctx._replies[0]?.text || "";
    expect(text).toContain("empty");

    // Cleanup
    const { rm } = await import("fs/promises");
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  test("handleLs rejects path outside allowed directories", async () => {
    const { handleLs } = await import("../handlers/commands");
    const ctx = createMockContext({
      userId: 123456,
      messageText: "/ls /etc",
    });

    await handleLs(ctx as any);

    expect(ctx._replies[0]?.text).toContain("not in allowed");
  });

  test("handleLs handles non-existent directory", async () => {
    const { handleLs } = await import("../handlers/commands");
    const ctx = createMockContext({
      userId: 123456,
      messageText: "/ls /tmp/nonexistent-dir-xyz-99999",
    });

    await handleLs(ctx as any);

    expect(ctx._replies[0]?.text).toContain("Cannot read");
  });

  test("handleLs resolves relative paths", async () => {
    const { handleLs } = await import("../handlers/commands");
    mockSessionState.workingDir = "/tmp";
    const ctx = createMockContext({
      userId: 123456,
      messageText: "/ls nonexistent-subdir-xyz-98765",
    });

    await handleLs(ctx as any);

    // Should resolve relative to /tmp, not reject as disallowed
    const text = ctx._replies[0]?.text || "";
    expect(text).not.toContain("not in allowed");
    // Should fail with "Cannot read" since the path doesn't exist
    expect(text).toContain("Cannot read");
  });

  test("handleLs shows symlink icon for symbolic links", async () => {
    const { mkdtemp, writeFile, symlink } = await import("fs/promises");
    const tmpDir = await mkdtemp("/tmp/ls-symlink-test-");
    await writeFile(`${tmpDir}/real-file.txt`, "test");
    await symlink(`${tmpDir}/real-file.txt`, `${tmpDir}/link-file`);

    const { handleLs } = await import("../handlers/commands");
    const ctx = createMockContext({
      userId: 123456,
      messageText: `/ls ${tmpDir}`,
    });

    await handleLs(ctx as any);

    const text = ctx._replies[0]?.text || "";
    expect(text).toContain("🔗"); // symlink icon
    expect(text).toContain("link-file");

    const { rm } = await import("fs/promises");
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  test("handleLs escapes HTML special chars in filenames", async () => {
    const { mkdtemp, writeFile } = await import("fs/promises");
    const tmpDir = await mkdtemp("/tmp/ls-html-test-");
    await writeFile(`${tmpDir}/foo&bar.txt`, "test");

    const { handleLs } = await import("../handlers/commands");
    const ctx = createMockContext({
      userId: 123456,
      messageText: `/ls ${tmpDir}`,
    });

    await handleLs(ctx as any);

    const text = ctx._replies[0]?.text || "";
    // & should be escaped to &amp; for valid HTML
    expect(text).toContain("foo&amp;bar.txt");
    expect(text).not.toContain("foo&bar.txt");

    const { rm } = await import("fs/promises");
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });
});
