/**
 * Unit tests for src/topics/topic-manager.ts.
 *
 * Uses a mocked Telegram API and mocked settings module.
 */

// Bootstrap env — must run before any import that touches config.ts.
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "test-token";
process.env.TELEGRAM_ALLOWED_USERS =
  process.env.TELEGRAM_ALLOWED_USERS || "12345";

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Api } from "grammy";

// Isolate the topic store path — without this, scheduleSave() in the real
// topic-store module writes to tmpdir()/claude-telegram-topics.json, which is
// the SAME path the running production bot reads from. A test run will then
// clobber the live mapping.
let _topicStoreTmpDir: string;
beforeAll(async () => {
  _topicStoreTmpDir = await mkdtemp(join(tmpdir(), "topic-manager-test-"));
  process.env.CLAUDE_TELEGRAM_TOPICS_FILE = join(
    _topicStoreTmpDir,
    "topics.json",
  );
  // createTopic/deleteTopic also append to the topic ledger — isolate it too,
  // or tests would pollute the real ~/.claude-mobile-bridge/topic-ledger.jsonl.
  process.env.CLAUDE_TELEGRAM_LEDGER_FILE = join(
    _topicStoreTmpDir,
    "topic-ledger.jsonl",
  );
});
afterAll(async () => {
  // Cancel any pending 100ms debounced save and reset in-memory state so
  // post-teardown saves (from other test files in the same bun-test process)
  // can't write leaked state to the real ~/.claude-mobile-bridge/topics.json.
  const { clearTopicStore } = await import("../topics/topic-store");
  clearTopicStore();
  delete process.env.CLAUDE_TELEGRAM_TOPICS_FILE;
  delete process.env.CLAUDE_TELEGRAM_LEDGER_FILE;
  await rm(_topicStoreTmpDir, { recursive: true, force: true });
});

// Spy on ledger writes — we assert tombstone / no-tombstone in deleteTopic tests.
const mockRecordTopicCreated = mock(async (_entry: object) => {});
const mockRecordTopicDeleted = mock(async (_topicId: number) => {});

mock.module("../topics/topic-ledger", () => ({
  recordTopicCreated: mockRecordTopicCreated,
  recordTopicDeleted: mockRecordTopicDeleted,
  readActiveLedger: async () => [],
}));

// Stub the message bus — topic-manager (step 6a) now sends online/history
// pings via getMessageBus(). Route bus sends into mockApi.sendMessage so the
// existing test instrumentation (existing topic detection, error propagation)
// still works. The bus contract is: error responses become
// { dropped: "error", reason }, success becomes { messageId }.
mock.module("../messaging", () => ({
  getMessageBus: () => ({
    send: async (msg: { chatId: number; content: string }) => {
      try {
        const res = await mockApi.sendMessage(msg.chatId, msg.content);
        return { messageId: (res as { message_id: number }).message_id };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { dropped: "error" as const, reason };
      }
    },
    edit: async () => ({ ok: true as const }),
  }),
  setMessageBus: () => {},
  createMessageBus: () => ({}),
}));

// Mock relay/discovery
const mockUpdatePortFile = mock((_pid: number, _updates: object) => {});

mock.module("../relay/discovery", () => ({
  scanPortFiles: mock(async () => [
    {
      port: 9999,
      pid: 11111,
      ppid: 22222,
      cwd: "/tmp/proj",
      startedAt: "2026-05-04T00:00:00.000Z",
      sessionId: "sid-1",
      sessionName: "my-session",
    },
  ]),
  updatePortFile: mockUpdatePortFile,
  isRelayProcess: () => true,
  invalidateScanCache: () => {},
}));

// Mock settings
mock.module("../settings", () => ({
  getTerminal: () => "terminal",
  getWorkingDir: () => "/tmp",
  getAutoWatchOnSpawn: () => true,
  getDefaultModelSetting: () => undefined,
  getEnablePinnedStatus: () => true,
  getGroupModeSetting: () => undefined,
  getContextNotifyStep: () => 0,
  getCursorEnabled: () => true,
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
  RELAY_PORT_FILE_PREFIX: "/tmp/test-channel-relay-",
  RELAY_CONNECT_TIMEOUT_MS: 3000,
  RELAY_RESPONSE_TIMEOUT_MS: 300000,
  SESSION_FILE: "/tmp/test-session.json",
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
  updateTopicMapping,
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
    mockApi.sendMessage.mockClear();
    mockRecordTopicDeleted.mockClear();
    mockRecordTopicCreated.mockClear();
  });

  test("createTopic creates forum topic and persists mapping", async () => {
    const mgr = createManager();
    const topicId = await mgr.createTopic("my-session", "/tmp/proj", "sid-1");

    expect(topicId).toBe(42);
    expect(mockApi.createForumTopic).toHaveBeenCalledTimes(1);
    expect(mockApi.createForumTopic.mock.calls[0]).toEqual([
      CHAT_ID,
      "my-session",
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

  test("updateTopicStatus updates store to online", async () => {
    seedMapping("sess", 50, false);
    const mgr = createManager();
    await mgr.updateTopicStatus("sess", true);

    const mapping = getTopicBySession("sess");
    expect(mapping!.isOnline).toBe(true);
  });

  test("updateTopicStatus updates store to offline", async () => {
    seedMapping("sess", 50, true);
    const mgr = createManager();
    await mgr.updateTopicStatus("sess", false);

    const mapping = getTopicBySession("sess");
    expect(mapping!.isOnline).toBe(false);
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

  test("reconcile deletes topics for sessions that are no longer live", async () => {
    seedMapping("gone-sess", 10, true);
    seedMapping("still-here", 20, true);
    const mgr = createManager();

    await mgr.reconcile([{ name: "still-here", dir: "/tmp/b" }]);

    expect(getTopicBySession("gone-sess")).toBeUndefined();
    expect(mockApi.deleteForumTopic).toHaveBeenCalledWith(CHAT_ID, 10);
  });

  test("reconcile does NOT delete cursor topics absent from liveSessions", async () => {
    // Cursor sessions register asynchronously via the cursor-bridge after
    // startup, so they're missing from the port-file-derived liveSessions
    // at reconcile time. They must not be pruned here.
    seedMapping("cursor-prompt_gen", 40, true);
    seedMapping("gone-cc", 41, true);
    const mgr = createManager();

    await mgr.reconcile([{ name: "still-alive-cc", dir: "/tmp/d" }]);

    expect(getTopicBySession("cursor-prompt_gen")).toBeDefined();
    expect(mockApi.deleteForumTopic).not.toHaveBeenCalledWith(CHAT_ID, 40);
    // Non-cursor stale topic is still pruned.
    expect(getTopicBySession("gone-cc")).toBeUndefined();
    expect(mockApi.deleteForumTopic).toHaveBeenCalledWith(CHAT_ID, 41);
  });

  test("reconcile recreates an existing online mapping whose TG topic was deleted", async () => {
    // Regression: a topic deleted in Telegram mid-run leaves a stale store
    // entry with isOnline:true. reconcile used to trust existing+online
    // mappings without probing, so a restart never healed it — every send hit
    // "message thread not found" and dropped. reconcile must validate the
    // topic still exists and recreate it if not.
    seedMapping("stale-sess", 88, true);

    // The validation probe to the (deleted) topic fails with TG's exact error.
    mockApi.sendMessage.mockImplementationOnce(() =>
      Promise.reject(new Error("Bad Request: message thread not found")),
    );

    const mgr = createManager();
    await mgr.reconcile([{ name: "stale-sess", dir: "/tmp/x", id: "sid-x" }]);

    expect(mockApi.createForumTopic).toHaveBeenCalled();
    const mapping = getTopicBySession("stale-sess");
    expect(mapping).toBeDefined();
    expect(mapping!.topicId).toBe(42); // freshly created, not the dead 88
  });

  test("reconcile reuses a healthy existing online topic without recreating", async () => {
    seedMapping("healthy-sess", 70, true);
    const mgr = createManager();

    await mgr.reconcile([{ name: "healthy-sess", dir: "/tmp/y", id: "sid-y" }]);

    // Probe succeeds (default mock), so the topic is reused, not recreated.
    expect(mockApi.createForumTopic).not.toHaveBeenCalled();
    expect(getTopicBySession("healthy-sess")!.topicId).toBe(70);
  });

  test("reconcile updates offline→online for sessions that came back", async () => {
    seedMapping("comeback", 30, false);
    const mgr = createManager();

    await mgr.reconcile([{ name: "comeback", dir: "/tmp/c" }]);

    const mapping = getTopicBySession("comeback");
    expect(mapping!.isOnline).toBe(true);
  });

  test("createTopic writes topicId and topicName back to port file", async () => {
    mockUpdatePortFile.mockClear();
    const mgr = createManager();
    await mgr.createTopic("my-session", "/tmp/proj", "sid-1");
    expect(mockUpdatePortFile).toHaveBeenCalledTimes(1);
    const [pid, updates] = mockUpdatePortFile.mock.calls[0]!;
    expect(pid).toBe(11111);
    expect((updates as Record<string, unknown>).topicId).toBeDefined();
    expect((updates as Record<string, unknown>).topicName).toBe("my-session");
  });

  // ---- Bug 1: sessionId clobber ----

  test("updateTopicMapping with empty-string sessionId does not overwrite stored UUID", () => {
    addTopicMapping({
      topicId: 55,
      sessionName: "protected",
      sessionDir: "/tmp/test",
      sessionId: "real-uuid-123",
      isOnline: true,
      createdAt: new Date().toISOString(),
    });

    updateTopicMapping("protected", { isOnline: false, sessionId: "" });

    const mapping = getTopicBySession("protected");
    expect(mapping!.sessionId).toBe("real-uuid-123");
    expect(mapping!.isOnline).toBe(false);
  });

  test("updateTopicMapping with undefined sessionId does not overwrite stored UUID", () => {
    addTopicMapping({
      topicId: 56,
      sessionName: "protected2",
      sessionDir: "/tmp/test",
      sessionId: "real-uuid-456",
      isOnline: true,
      createdAt: new Date().toISOString(),
    });

    updateTopicMapping("protected2", { isOnline: false, sessionId: undefined });

    const mapping = getTopicBySession("protected2");
    expect(mapping!.sessionId).toBe("real-uuid-456");
  });

  // ---- Bug 2: deleteTopic tombstone on transient failure ----

  test("deleteTopic on transient error (429) keeps mapping and writes no tombstone", async () => {
    seedMapping("rate-limited", 77);
    mockApi.deleteForumTopic.mockImplementationOnce(() =>
      Promise.reject(new Error("Too Many Requests: retry after 1")),
    );

    const mgr = createManager();
    await mgr.deleteTopic("rate-limited");

    expect(getTopicBySession("rate-limited")).toBeDefined();
    expect(mockRecordTopicDeleted).not.toHaveBeenCalled();
  });

  test("deleteTopic when topic already gone ('message thread not found') removes mapping and writes tombstone", async () => {
    seedMapping("already-gone", 88);
    mockApi.deleteForumTopic.mockImplementationOnce(() =>
      Promise.reject(new Error("Bad Request: message thread not found")),
    );

    const mgr = createManager();
    await mgr.deleteTopic("already-gone");

    expect(getTopicBySession("already-gone")).toBeUndefined();
    expect(mockRecordTopicDeleted).toHaveBeenCalledWith(88);
  });

  // ---- Bug 3: concurrent createTopic in-flight guard ----

  test("two concurrent createTopic calls for same session produce one createForumTopic API call", async () => {
    let releaseCreate!: (v: {
      message_thread_id: number;
      name: string;
      icon_color: number;
    }) => void;
    const deferred = new Promise<{
      message_thread_id: number;
      name: string;
      icon_color: number;
    }>((res) => {
      releaseCreate = res;
    });
    mockApi.createForumTopic.mockImplementationOnce(() => deferred);

    const mgr = createManager();
    const p1 = mgr.createTopic("concurrent-sess", "/tmp/proj");
    const p2 = mgr.createTopic("concurrent-sess", "/tmp/proj");

    releaseCreate({
      message_thread_id: 42,
      name: "concurrent-sess",
      icon_color: 0,
    });

    const [id1, id2] = await Promise.all([p1, p2]);

    expect(mockApi.createForumTopic).toHaveBeenCalledTimes(1);
    expect(id1).toBe(42);
    expect(id2).toBe(42);
  });
});
