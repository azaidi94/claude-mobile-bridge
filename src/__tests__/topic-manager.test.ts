/**
 * Unit tests for src/topics/topic-manager.ts.
 *
 * Uses a mocked Telegram API and mocked settings module.
 */

// Bootstrap env — must run before any import that touches config.ts.
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "test-token";
process.env.TELEGRAM_ALLOWED_USERS =
  process.env.TELEGRAM_ALLOWED_USERS || "12345";

import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { Api } from "grammy";

// Mock settings — topics enabled by default
mock.module("../settings", () => ({
  getTopicsEnabled: () => true,
  getTerminal: () => "terminal",
  getWorkingDir: () => "/tmp",
  getAutoWatchOnSpawn: () => true,
  getDefaultModelSetting: () => undefined,
  getEnablePinnedStatus: () => true,
  getOverrides: () => ({}),
  saveSetting: async () => {},
  _reloadForTests: () => {},
}));

// Mock config with basic values
mock.module("../config", () => ({
  TELEGRAM_TOKEN: "test-token",
  ALLOWED_USERS: [12345],
  WORKING_DIR: "/tmp",
  BOT_DIR: "/tmp/bot",
  OPENAI_API_KEY: "",
  CLAUDE_CLI_PATH: "/usr/local/bin/claude",
  DESKTOP_TERMINAL_APP: "terminal",
  DESKTOP_CLAUDE_DEFAULT_ARGS: "",
  DESKTOP_CLAUDE_COMMAND_TEMPLATE: "",
  MCP_SERVERS: {},
  SAFETY_PROMPT: "",
  BLOCKED_PATTERNS: [],
  QUERY_TIMEOUT_MS: 180000,
  TRANSCRIPTION_PROMPT: "",
  TRANSCRIPTION_AVAILABLE: false,
  THINKING_KEYWORDS: [],
  THINKING_DEEP_KEYWORDS: [],
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
  WEB_PORT: undefined,
  WEB_TOKEN: "",
  TTS_RESPONSE_FORMAT: "opus",
  RELAY_PORT_FILE_PREFIX: "/tmp/channel-relay-",
  RELAY_CONNECT_TIMEOUT_MS: 3000,
  RELAY_RESPONSE_TIMEOUT_MS: 300000,
  SESSION_FILE: "/tmp/claude-telegram-session.json",
  RESTART_FILE: "/tmp/claude-telegram-restart.json",
  TEMP_DIR: "/tmp/telegram-bot",
  TEMP_PATHS: ["/tmp/"],
  ALLOWED_PATHS: ["/tmp"],
  findClaudeCli: () => "/usr/local/bin/claude",
  isDesktopClaudeSpawnSupported: () => false,
  parseTerminalApp: (s: string) => s || "terminal",
}));

import {
  clearTopicStore,
  addTopicMapping,
  getTopicBySession,
  getTopicStore,
} from "../topics/topic-store";
import { TopicManager } from "../topics/topic-manager";

const mockApi = {
  createForumTopic: mock((_chatId: number, _name: string, _opts: object) =>
    Promise.resolve({ message_thread_id: 42, name: "test", icon_color: 0 }),
  ),
  editForumTopic: mock((_chatId: number, _topicId: number, _opts: object) =>
    Promise.resolve(true),
  ),
  deleteForumTopic: mock((_chatId: number, _topicId: number) =>
    Promise.resolve(true),
  ),
  sendMessage: mock((_chatId: number, _text: string) =>
    Promise.resolve({ message_id: 1 }),
  ),
  pinChatMessage: mock((_chatId: number, _msgId: number) =>
    Promise.resolve(true),
  ),
};

const CHAT_ID = -100123;

function createManager(): TopicManager {
  return new TopicManager(mockApi as unknown as Api, CHAT_ID);
}

function seedMapping(
  sessionName: string,
  topicId: number,
  isOnline = true,
): void {
  addTopicMapping({
    topicId,
    sessionName,
    sessionDir: "/tmp/test",
    isOnline,
    createdAt: new Date().toISOString(),
  });
}

describe("TopicManager", () => {
  beforeEach(() => {
    clearTopicStore();
    mockApi.createForumTopic.mockClear();
    mockApi.editForumTopic.mockClear();
    mockApi.deleteForumTopic.mockClear();
  });

  test("createTopic creates forum topic and persists mapping", async () => {
    const mgr = createManager();
    const topicId = await mgr.createTopic("my-session", "/tmp/proj", "sid-1");

    expect(topicId).toBe(42);
    expect(mockApi.createForumTopic).toHaveBeenCalledTimes(1);
    expect(mockApi.createForumTopic.mock.calls[0]).toEqual([
      CHAT_ID,
      "🟢 my-session",
      {},
    ]);

    const mapping = getTopicBySession("my-session");
    expect(mapping).toBeDefined();
    expect(mapping!.topicId).toBe(42);
    expect(mapping!.sessionId).toBe("sid-1");
    expect(mapping!.isOnline).toBe(true);
  });

  test("createTopic returns existing topicId if mapping exists", async () => {
    seedMapping("existing", 99);
    const mgr = createManager();
    const topicId = await mgr.createTopic("existing", "/tmp/proj");

    expect(topicId).toBe(99);
    expect(mockApi.createForumTopic).not.toHaveBeenCalled();
  });

  test("deleteTopic deletes forum topic and removes mapping", async () => {
    seedMapping("doomed", 77);
    const mgr = createManager();
    await mgr.deleteTopic("doomed");

    expect(mockApi.deleteForumTopic).toHaveBeenCalledTimes(1);
    expect(mockApi.deleteForumTopic.mock.calls[0]).toEqual([CHAT_ID, 77]);
    expect(getTopicBySession("doomed")).toBeUndefined();
  });

  test("deleteTopic handles missing mapping gracefully", async () => {
    const mgr = createManager();
    // Should not throw
    await mgr.deleteTopic("nonexistent");
    expect(mockApi.deleteForumTopic).not.toHaveBeenCalled();
  });

  test("updateTopicStatus renames topic with online emoji", async () => {
    seedMapping("sess", 50, false);
    const mgr = createManager();
    await mgr.updateTopicStatus("sess", true);

    expect(mockApi.editForumTopic).toHaveBeenCalledTimes(1);
    expect(mockApi.editForumTopic.mock.calls[0]).toEqual([
      CHAT_ID,
      50,
      { name: "🟢 sess" },
    ]);
  });

  test("updateTopicStatus renames topic with offline emoji", async () => {
    seedMapping("sess", 50, true);
    const mgr = createManager();
    await mgr.updateTopicStatus("sess", false);

    expect(mockApi.editForumTopic).toHaveBeenCalledTimes(1);
    expect(mockApi.editForumTopic.mock.calls[0]).toEqual([
      CHAT_ID,
      50,
      { name: "🔴 sess" },
    ]);
  });

  test("updateTopicStatus renames topic with thinking emoji", async () => {
    seedMapping("sess", 50, true);
    const mgr = createManager();
    await mgr.updateTopicStatus("sess", true, true);

    expect(mockApi.editForumTopic).toHaveBeenCalledTimes(1);
    expect(mockApi.editForumTopic.mock.calls[0]).toEqual([
      CHAT_ID,
      50,
      { name: "🟡 sess" },
    ]);
  });

  test("createTopic handles API error gracefully", async () => {
    mockApi.createForumTopic.mockImplementationOnce(() =>
      Promise.reject(new Error("Telegram API error")),
    );
    const mgr = createManager();
    const topicId = await mgr.createTopic("fail-sess", "/tmp/proj");

    expect(topicId).toBeUndefined();
    expect(getTopicBySession("fail-sess")).toBeUndefined();
  });

  test("reconcile creates topics for sessions without mappings", async () => {
    const mgr = createManager();
    await mgr.reconcile([
      { name: "new-sess", dir: "/tmp/a" },
      { name: "another", dir: "/tmp/b", id: "id-2" },
    ]);

    expect(mockApi.createForumTopic).toHaveBeenCalledTimes(2);
    expect(getTopicStore().topics).toHaveLength(2);
  });

  test("reconcile marks offline sessions that are no longer live", async () => {
    seedMapping("gone-sess", 10, true);
    seedMapping("still-here", 20, true);
    const mgr = createManager();

    await mgr.reconcile([{ name: "still-here", dir: "/tmp/b" }]);

    // gone-sess should be marked offline
    expect(mockApi.editForumTopic).toHaveBeenCalledTimes(1);
    expect(mockApi.editForumTopic.mock.calls[0]).toEqual([
      CHAT_ID,
      10,
      { name: "🔴 gone-sess" },
    ]);

    const gone = getTopicBySession("gone-sess");
    expect(gone!.isOnline).toBe(false);
  });

  test("reconcile updates offline→online for sessions that came back", async () => {
    seedMapping("comeback", 30, false);
    const mgr = createManager();

    await mgr.reconcile([{ name: "comeback", dir: "/tmp/c" }]);

    expect(mockApi.editForumTopic).toHaveBeenCalledTimes(1);
    expect(mockApi.editForumTopic.mock.calls[0]).toEqual([
      CHAT_ID,
      30,
      { name: "🟢 comeback" },
    ]);

    const mapping = getTopicBySession("comeback");
    expect(mapping!.isOnline).toBe(true);
  });
});
