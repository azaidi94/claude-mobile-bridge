/**
 * Integration tests for the topics module.
 * Verifies full topic flow end-to-end: store CRUD, router resolution,
 * manager lifecycle, reconciliation, and safeSendInThread fallback.
 */

// Bootstrap env
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "test-token";
process.env.TELEGRAM_ALLOWED_USERS =
  process.env.TELEGRAM_ALLOWED_USERS || "12345";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm, readFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// --- Mock settings ---
mock.module("../settings", () => ({
  getEnablePinnedStatus: () => true,
  getTerminal: () => "Terminal" as const,
  getWorkingDir: () => "/tmp",
  getAutoWatchOnSpawn: () => true,
  getDefaultModelSetting: () => undefined,
  getOverrides: () => ({}),
  saveSetting: async () => {},
  _reloadForTests: () => {},
}));

// --- Mock config ---
mock.module("../config", () => ({
  ALLOWED_USERS: [123456],
  TELEGRAM_TOKEN: "test-token",
  WORKING_DIR: "/tmp",
  BOT_DIR: "/tmp/bot",
  OPENAI_API_KEY: "",
  CLAUDE_CLI_PATH: "/usr/local/bin/claude",
  DESKTOP_TERMINAL_APP: "Terminal",
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
  BUTTON_LABEL_MAX_LENGTH: 64,
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
  parseTerminalApp: (s: string) => s || "Terminal",
}));

// --- Mock sessions/history (used by TopicManager.createTopic) ---
mock.module("../sessions/history", () => ({
  getRecentHistory: async () => [],
  formatHistoryMessage: () => "",
}));

import type { Api, Context } from "grammy";
import {
  clearTopicStore,
  addTopicMapping,
  getTopicBySession,
  getSessionByTopic,
  getTopicStore,
  setChatId,
  updateTopicMapping,
  removeTopicMapping,
  saveTopicStore,
  loadTopicStore,
} from "../topics/topic-store";
import {
  isGeneralTopic,
  isSessionTopic,
  getThreadId,
  safeSendInThread,
} from "../topics/topic-router";
import { TopicManager } from "../topics/topic-manager";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "topics-integ-"));
  process.env.CLAUDE_TELEGRAM_TOPICS_FILE = join(tmpDir, "topics.json");
  clearTopicStore();
});

afterEach(async () => {
  clearTopicStore();
  delete process.env.CLAUDE_TELEGRAM_TOPICS_FILE;
  await rm(tmpDir, { recursive: true, force: true });
});

const CHAT_ID = -100999;

function makeMapping(
  sessionName: string,
  topicId: number,
  opts: Partial<{
    sessionDir: string;
    isOnline: boolean;
    sessionId: string;
  }> = {},
) {
  return {
    topicId,
    sessionName,
    sessionDir: opts.sessionDir ?? "/tmp/test",
    sessionId: opts.sessionId,
    isOnline: opts.isOnline ?? true,
    createdAt: new Date().toISOString(),
  };
}

function makeCtx(threadId?: number): Context {
  return {
    message: threadId !== undefined ? { message_thread_id: threadId } : {},
  } as unknown as Context;
}

function makeMockApi() {
  return {
    createForumTopic: mock((_chatId: number, _name: string, _opts: object) =>
      Promise.resolve({ message_thread_id: 500, name: "test", icon_color: 0 }),
    ),
    editForumTopic: mock((_chatId: number, _topicId: number, _opts: object) =>
      Promise.resolve(true),
    ),
    deleteForumTopic: mock((_chatId: number, _topicId: number) =>
      Promise.resolve(true),
    ),
    sendMessage: mock((_chatId: number, _text: string, _opts?: object) =>
      Promise.resolve({ message_id: 1 }),
    ),
    pinChatMessage: mock((_chatId: number, _msgId: number) =>
      Promise.resolve(true),
    ),
  };
}

// ──────────────────────────────────────────────────────
// 1. Topic store CRUD flow
// ──────────────────────────────────────────────────────

describe("topic store CRUD flow", () => {
  test("create multiple mappings, query by session and topicId", () => {
    addTopicMapping(makeMapping("alpha", 10));
    addTopicMapping(makeMapping("beta", 20));
    addTopicMapping(makeMapping("gamma", 30));

    expect(getTopicStore().topics).toHaveLength(3);

    expect(getTopicBySession("alpha")!.topicId).toBe(10);
    expect(getTopicBySession("beta")!.topicId).toBe(20);
    expect(getTopicBySession("gamma")!.topicId).toBe(30);

    expect(getSessionByTopic(10)!.sessionName).toBe("alpha");
    expect(getSessionByTopic(20)!.sessionName).toBe("beta");
    expect(getSessionByTopic(30)!.sessionName).toBe("gamma");
  });

  test("update status and remove, verify state", () => {
    addTopicMapping(makeMapping("s1", 100, { isOnline: true }));
    addTopicMapping(makeMapping("s2", 200, { isOnline: true }));

    updateTopicMapping("s1", { isOnline: false });
    expect(getTopicBySession("s1")!.isOnline).toBe(false);
    expect(getTopicBySession("s2")!.isOnline).toBe(true);

    removeTopicMapping("s1");
    expect(getTopicBySession("s1")).toBeUndefined();
    expect(getTopicStore().topics).toHaveLength(1);
  });

  test("persistence round-trip: save, clear, load", async () => {
    setChatId(777);
    addTopicMapping(makeMapping("persist-a", 40, { sessionDir: "/a" }));
    addTopicMapping(makeMapping("persist-b", 50, { sessionDir: "/b" }));

    await saveTopicStore();
    const storePath = process.env.CLAUDE_TELEGRAM_TOPICS_FILE!;
    expect(existsSync(storePath)).toBe(true);

    const raw = JSON.parse(await readFile(storePath, "utf-8"));
    expect(raw.chatId).toBe(777);
    expect(raw.topics).toHaveLength(2);

    clearTopicStore();
    expect(getTopicStore().topics).toHaveLength(0);

    await loadTopicStore();
    expect(getTopicStore().chatId).toBe(777);
    expect(getTopicStore().topics).toHaveLength(2);
    expect(getTopicBySession("persist-a")!.sessionDir).toBe("/a");
    expect(getTopicBySession("persist-b")!.sessionDir).toBe("/b");
  });
});

// ──────────────────────────────────────────────────────
// 2. Topic router context resolution
// ──────────────────────────────────────────────────────

describe("topic router context resolution", () => {
  test("isGeneralTopic/isSessionTopic with store mappings", () => {
    addTopicMapping(makeMapping("sess-a", 42));
    addTopicMapping(makeMapping("sess-b", 99));

    // General topic (no thread_id)
    expect(isGeneralTopic(makeCtx())).toBe(true);
    expect(isSessionTopic(makeCtx())).toBeNull();

    // General topic (thread_id=1)
    expect(isGeneralTopic(makeCtx(1))).toBe(true);
    expect(isSessionTopic(makeCtx(1))).toBeNull();

    // Known session topic
    const resultA = isSessionTopic(makeCtx(42));
    expect(resultA).not.toBeNull();
    expect(resultA!.sessionName).toBe("sess-a");
    expect(resultA!.topicId).toBe(42);
    expect(isGeneralTopic(makeCtx(42))).toBe(false);

    const resultB = isSessionTopic(makeCtx(99));
    expect(resultB).not.toBeNull();
    expect(resultB!.sessionName).toBe("sess-b");

    // Unknown thread_id
    expect(isSessionTopic(makeCtx(12345))).toBeNull();
    expect(isGeneralTopic(makeCtx(12345))).toBe(false);
  });
});

// ──────────────────────────────────────────────────────
// 3. Topic manager create/delete lifecycle
// ──────────────────────────────────────────────────────

describe("topic manager create/delete lifecycle", () => {
  test("create topic → mapping persisted, delete → mapping removed + API called", async () => {
    const api = makeMockApi();
    const mgr = new TopicManager(api as unknown as Api, CHAT_ID);

    // Create
    const topicId = await mgr.createTopic(
      "lifecycle-sess",
      "/tmp/proj",
      "sid-1",
    );
    expect(topicId).toBe(500); // mock returns 500
    expect(api.createForumTopic).toHaveBeenCalledTimes(1);

    const mapping = getTopicBySession("lifecycle-sess");
    expect(mapping).toBeDefined();
    expect(mapping!.topicId).toBe(500);
    expect(mapping!.sessionId).toBe("sid-1");
    expect(mapping!.isOnline).toBe(true);

    // Delete
    await mgr.deleteTopic("lifecycle-sess");
    expect(api.deleteForumTopic).toHaveBeenCalledTimes(1);
    expect(api.deleteForumTopic.mock.calls[0]).toEqual([CHAT_ID, 500]);
    expect(getTopicBySession("lifecycle-sess")).toBeUndefined();
  });

  test("create returns existing topicId without API call", async () => {
    addTopicMapping(makeMapping("existing", 888));
    const api = makeMockApi();
    const mgr = new TopicManager(api as unknown as Api, CHAT_ID);

    const topicId = await mgr.createTopic("existing", "/tmp/proj");
    expect(topicId).toBe(888);
    expect(api.createForumTopic).not.toHaveBeenCalled();
  });

  test("delete nonexistent session is a no-op", async () => {
    const api = makeMockApi();
    const mgr = new TopicManager(api as unknown as Api, CHAT_ID);

    await mgr.deleteTopic("ghost");
    expect(api.deleteForumTopic).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────
// 4. Topic manager reconcile
// ──────────────────────────────────────────────────────

describe("topic manager reconcile", () => {
  test("creates missing, marks offline stale, brings back online", async () => {
    const api = makeMockApi();
    let nextTopicId = 300;
    api.createForumTopic.mockImplementation(() =>
      Promise.resolve({
        message_thread_id: nextTopicId++,
        name: "t",
        icon_color: 0,
      }),
    );

    // Seed: one live, one stale, one offline
    addTopicMapping(makeMapping("still-here", 100, { isOnline: true }));
    addTopicMapping(makeMapping("gone-away", 200, { isOnline: true }));
    addTopicMapping(makeMapping("was-offline", 250, { isOnline: false }));

    const mgr = new TopicManager(api as unknown as Api, CHAT_ID);
    await mgr.reconcile([
      { name: "still-here", dir: "/tmp/a" },
      { name: "was-offline", dir: "/tmp/b" },
      { name: "brand-new", dir: "/tmp/c", id: "id-new" },
    ]);

    // "gone-away" should be deleted
    expect(getTopicBySession("gone-away")).toBeUndefined();
    expect(api.deleteForumTopic).toHaveBeenCalledWith(CHAT_ID, 200);

    // "was-offline" should be brought back online
    expect(getTopicBySession("was-offline")!.isOnline).toBe(true);

    // "brand-new" should have a new topic created
    const brandNew = getTopicBySession("brand-new");
    expect(brandNew).toBeDefined();
    expect(brandNew!.topicId).toBe(300);

    // "still-here" stays online, no status change API call needed
    expect(getTopicBySession("still-here")!.isOnline).toBe(true);

    // API calls: 1 create (brand-new), 1 delete (gone-away)
    expect(api.createForumTopic).toHaveBeenCalledTimes(1);
    expect(api.deleteForumTopic).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────
// 5. safeSendInThread fallback
// ──────────────────────────────────────────────────────

describe("safeSendInThread fallback", () => {
  test("retries without threadId on 'message thread not found' and cleans up mapping", async () => {
    addTopicMapping(makeMapping("stale-sess", 42));

    const api = makeMockApi();
    let callCount = 0;
    api.sendMessage.mockImplementation(
      (_chatId: number, _text: string, opts?: any) => {
        callCount++;
        if (opts?.message_thread_id === 42) {
          return Promise.reject(
            new Error("Bad Request: message thread not found"),
          );
        }
        return Promise.resolve({ message_id: 99 });
      },
    );

    const result = await safeSendInThread(
      api as unknown as Api,
      CHAT_ID,
      "hello",
      42,
    );

    expect(result.message_id).toBe(99);
    expect(callCount).toBe(2); // first attempt + retry
    expect(getTopicBySession("stale-sess")).toBeUndefined(); // mapping cleaned up
  });

  test("rethrows non-thread errors", async () => {
    const api = makeMockApi();
    api.sendMessage.mockImplementation(() =>
      Promise.reject(new Error("rate limit")),
    );

    await expect(
      safeSendInThread(api as unknown as Api, CHAT_ID, "hi", 42),
    ).rejects.toThrow("rate limit");
  });
});

// ──────────────────────────────────────────────────────
// 6. getThreadId
// ──────────────────────────────────────────────────────

describe("getThreadId", () => {
  test("returns topicId for mapped session", () => {
    addTopicMapping(makeMapping("sess", 77));
    expect(getThreadId("sess")).toBe(77);
  });

  test("returns undefined for unknown session", () => {
    expect(getThreadId("unknown")).toBeUndefined();
  });
});
