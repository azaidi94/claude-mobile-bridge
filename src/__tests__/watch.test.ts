/**
 * Unit tests for watch handler state management and formatStatusMessage isWatching.
 *
 * Tests watch state lifecycle, isWatching/stopWatching helpers,
 * notifySessionOffline, and the new isWatching status format.
 */

import "./ensure-test-env";
import { describe, expect, test, mock } from "bun:test";

mock.module("../config", () => ({
  ALLOWED_USERS: [123],
  TELEGRAM_TOKEN: "test-token",
  WORKING_DIR: "/tmp/test-working-dir",
  OPENAI_API_KEY: "",
  CLAUDE_CLI_PATH: "/usr/local/bin/claude",
  MCP_SERVERS: {},
  ALLOWED_PATHS: ["/tmp"],
  SAFETY_PROMPT: "test prompt",
  BLOCKED_PATTERNS: [],
  QUERY_TIMEOUT_MS: 180000,
  TRANSCRIPTION_AVAILABLE: false,
  STREAMING_THROTTLE_MS: 500,
  RATE_LIMIT_ENABLED: false,
  RATE_LIMIT_REQUESTS: 20,
  RATE_LIMIT_WINDOW: 60,
  SESSION_FILE: "/tmp/test-session.json",
  TEMP_PATHS: ["/tmp/"],
}));

mock.module("../security", () => ({
  isAuthorized: (userId: number, allowedUsers: number[]) =>
    allowedUsers.includes(userId),
  rateLimiter: { check: () => [true] },
  isPathAllowed: () => true,
  checkCommandSafety: () => [true, ""],
}));

mock.module("../settings", () => ({
  getWorkingDir: () => "/tmp/test-working-dir",
  getTerminal: () => "terminal" as const,
  getAutoWatchOnSpawn: () => true,
  getDefaultModelSetting: () => undefined,
  getOverrides: () => ({}),
  saveSetting: mock(() => Promise.resolve()),
  _reloadForTests: mock(() => {}),
  getEnablePinnedStatus: () => true,
  getGroupModeSetting: () => undefined,
}));

// Import directly from source to avoid barrel export issues
import {
  formatStatusMessage,
  type StatusInfo,
} from "../sessions/status-message";

// ============== formatStatusMessage with isWatching ==============

describe("watch: formatStatusMessage isWatching", () => {
  test("formats watching state correctly", () => {
    const status: StatusInfo = {
      sessionName: null,
      isPlanMode: false,
      model: "Opus 4.6",
      isWatching: "my-project",
    };

    const result = formatStatusMessage(status);
    expect(result).toBe("👁 Watching: my-project | Opus 4.6");
  });

  test("watching state includes branch", () => {
    const status: StatusInfo = {
      sessionName: null,
      isPlanMode: false,
      model: "Sonnet 4.6",
      branch: "main",
      isWatching: "my-project",
    };

    const result = formatStatusMessage(status);
    expect(result).toBe("👁 Watching: my-project | Sonnet 4.6 | 🌿 main");
  });

  test("watching state ignores isPlanMode and sessionName", () => {
    const status: StatusInfo = {
      sessionName: "other-session",
      isPlanMode: true,
      model: "Opus 4.6",
      isWatching: "watched-session",
    };

    const result = formatStatusMessage(status);
    // Should show watching, not the session name or plan mode
    expect(result).toContain("👁 Watching: watched-session");
    expect(result).not.toContain("other-session");
    expect(result).not.toContain("Plan");
  });

  test("isWatching null falls back to normal format", () => {
    const status: StatusInfo = {
      sessionName: "my-project",
      isPlanMode: false,
      model: "Opus 4.6",
      isWatching: null,
    };

    const result = formatStatusMessage(status);
    expect(result).toBe("✅ my-project | ⚡ Normal | Opus 4.6");
  });

  test("isWatching undefined falls back to normal format", () => {
    const status: StatusInfo = {
      sessionName: "my-project",
      isPlanMode: false,
      model: "Opus 4.6",
    };

    const result = formatStatusMessage(status);
    expect(result).toBe("✅ my-project | ⚡ Normal | Opus 4.6");
  });
});

// ============== Watch state management ==============
// These tests import directly from the handler module.
// Since the watch module depends on grammy types at import time,
// we test the pure logic through formatStatusMessage and parseLine
// which don't require grammy. Integration tests for isWatching/
// stopWatching/notifySessionOffline would require a full bot mock.

describe("watch: state management (via exports)", () => {
  test("isWatching and stopWatching are exported", async () => {
    // Verify the handler module exports are available
    const mod = await import("../handlers/watch");
    expect(typeof mod.isWatching).toBe("function");
    expect(typeof mod.stopWatching).toBe("function");
    expect(typeof mod.notifySessionOffline).toBe("function");
    expect(typeof mod.handleWatch).toBe("function");
    expect(typeof mod.handleUnwatch).toBe("function");
  });

  test("isWatching returns false for unknown chat", async () => {
    const { isWatching } = await import("../handlers/watch");
    expect(isWatching(999999999, 1)).toBe(false);
  });

  test("stopWatching returns undefined for unknown chat", async () => {
    const { stopWatching } = await import("../handlers/watch");
    const result = stopWatching(999999999, 1);
    expect(result).toBeUndefined();
  });

  test("_resetWatchesForTests clears state", async () => {
    const mod = await import("../handlers/watch");
    expect(typeof mod._resetWatchesForTests).toBe("function");
    expect(typeof mod._registerWatchForTests).toBe("function");
    mod._resetWatchesForTests();
    expect(mod.isWatching(123456, 1)).toBe(false);
  });
});

describe("watch: multi-topic isolation", () => {
  const makeState = (
    chatId: number,
    threadId: number,
    sessionDir: string,
  ): any => ({
    chatId,
    threadId,
    sessionName: `s-${threadId}`,
    sessionId: `id-${threadId}`,
    sessionDir,
    currentToolMsg: null,
    currentTextMsg: null,
    currentTextContent: "",
    lastTextUpdate: 0,
    segmentDone: true,
    lastEventTime: Date.now(),
    tailer: { stop: () => {} },
  });

  test("isWatching distinguishes topics under the same chatId", async () => {
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();
    mod._registerWatchForTests(makeState(100, 1, "/repo/a"));

    expect(mod.isWatching(100, 1)).toBe(true);
    expect(mod.isWatching(100, 2)).toBe(false);
  });

  test("isWatchingAny is true while any watch exists for the chat", async () => {
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();

    expect(mod.isWatchingAny(100)).toBe(false);
    mod._registerWatchForTests(makeState(100, 1, "/repo/a"));
    expect(mod.isWatchingAny(100)).toBe(true);
    mod.stopWatching(100, 1);
    expect(mod.isWatchingAny(100)).toBe(false);
  });

  test("stopWatching(chatId, threadId) only removes the target entry", async () => {
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();

    mod._registerWatchForTests(makeState(100, 1, "/repo/a"));
    mod._registerWatchForTests(makeState(100, 2, "/repo/b"));

    mod.stopWatching(100, 1);

    expect(mod.isWatching(100, 1)).toBe(false);
    expect(mod.isWatching(100, 2)).toBe(true);
  });

  test("stopWatchByName only removes the watch whose sessionName matches", async () => {
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();

    mod._registerWatchForTests(makeState(100, 1, "/repo/a"));
    mod._registerWatchForTests(makeState(100, 2, "/repo/b"));

    const stopped = mod.stopWatchByName("s-1");

    expect(stopped?.sessionName).toBe("s-1");
    expect(mod.isWatching(100, 1)).toBe(false);
    expect(mod.isWatching(100, 2)).toBe(true);
  });

  test("stopWatchByName targets the named sibling when two watches share a dir", async () => {
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();

    mod._registerWatchForTests(makeState(100, 1, "/repo/shared"));
    mod._registerWatchForTests(makeState(100, 2, "/repo/shared"));

    const stopped = mod.stopWatchByName("s-2");

    expect(stopped?.sessionName).toBe("s-2");
    expect(mod.isWatching(100, 1)).toBe(true);
    expect(mod.isWatching(100, 2)).toBe(false);
  });

  test("stopWatchByName returns undefined for unknown name", async () => {
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();
    expect(mod.stopWatchByName("nonexistent")).toBeUndefined();
  });
});

describe("handleWatch: General-chat rejection", () => {
  test("rejects when message has no thread", async () => {
    const { handleWatch } = await import("../handlers/watch");
    const replies: string[] = [];
    const ctx = {
      from: { id: 123 },
      chat: { id: 456 },
      message: {}, // no message_thread_id
      reply: (text: string) => {
        replies.push(text);
        return Promise.resolve();
      },
    } as any;

    await handleWatch(ctx);
    expect(replies.length).toBe(1);
    expect(replies[0]).toContain("per-topic");
  });
});

describe("watch: handleTailEvent user-event origin filter", () => {
  const makeState = (
    chatId: number,
    threadId: number,
    sessionDir: string,
  ): any => ({
    chatId,
    threadId,
    sessionName: `s-${threadId}`,
    sessionId: `id-${threadId}`,
    sessionDir,
    currentToolMsg: null,
    currentTextMsg: null,
    currentTextContent: "",
    lastTextUpdate: 0,
    segmentDone: true,
    lastEventTime: Date.now(),
    tailer: { stop: () => {} },
  });

  function makeMockApi() {
    const sent: Array<{
      chatId: number | string;
      text: string;
      opts?: unknown;
    }> = [];
    const api = {
      sendMessage: (chatId: number | string, text: string, opts?: unknown) => {
        sent.push({ chatId, text, opts });
        return Promise.resolve({ message_id: 1 });
      },
      deleteMessage: () => Promise.resolve(true),
      sendChatAction: () => Promise.resolve(true),
    } as unknown as import("grammy").Api;
    return { api, sent };
  }

  test("user event with originChat === ownChat is skipped (TCP dedup)", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      { type: "user", content: "hi", originChat: "-1003968796171" },
      6302,
    );
    expect(sent).toHaveLength(0);
  });

  test("user event with originChat === 'web' renders with 🌐 Web label", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      { type: "user", content: "hmmm", originChat: "web" },
      6302,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("🌐");
    expect(sent[0]!.text).toContain("Web");
    expect(sent[0]!.text).toContain("hmmm");
  });

  test("user event with originChat undefined renders Desktop (terminal-typed)", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      { type: "user", content: "native input" },
      6302,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("🖥");
    expect(sent[0]!.text).toContain("Desktop");
    expect(sent[0]!.text).toContain("native input");
  });

  test("user event from a foreign Telegram chat renders 💬 Chat label", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      { type: "user", content: "cross-chat", originChat: "-200999" },
      6302,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("💬");
    expect(sent[0]!.text).toContain("Chat");
    expect(sent[0]!.text).toContain("-200999");
  });
});

describe("watch: handleTailEvent relay_reply origin filter", () => {
  const makeState = (
    chatId: number,
    threadId: number,
    sessionDir: string,
  ): any => ({
    chatId,
    threadId,
    sessionName: `s-${threadId}`,
    sessionId: `id-${threadId}`,
    sessionDir,
    currentToolMsg: null,
    currentTextMsg: null,
    currentTextContent: "",
    lastTextUpdate: 0,
    segmentDone: true,
    lastEventTime: Date.now(),
    tailer: { stop: () => {} },
  });

  function makeMockApi() {
    const sent: Array<{
      chatId: number | string;
      text: string;
      opts?: unknown;
    }> = [];
    const api = {
      sendMessage: (chatId: number | string, text: string, opts?: unknown) => {
        sent.push({ chatId, text, opts });
        return Promise.resolve({ message_id: 1 });
      },
      deleteMessage: () => Promise.resolve(true),
      sendChatAction: () => Promise.resolve(true),
    } as unknown as import("grammy").Api;
    return { api, sent };
  }

  test("relay_reply with originChat === ownChat sends nothing (TCP dedup preserved)", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    (state as any).suppressRelayReplyText = true; // TCP already delivered
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      { type: "relay_reply", content: "hello", originChat: "-1003968796171" },
      6302,
    );
    expect(sent).toHaveLength(0);
  });

  test("relay_reply with originChat === undefined sends nothing (dedup for own-path)", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    (state as any).suppressRelayReplyText = true; // TCP already delivered
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      { type: "relay_reply", content: "hello" },
      6302,
    );
    expect(sent).toHaveLength(0);
  });

  test("relay_reply with foreign originChat ('web') sends the text to this Telegram chat", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      { type: "relay_reply", content: "from web", originChat: "web" },
      6302,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("from web");
  });

  test("relay_reply own-chat WITHOUT suppressRelayReplyText falls back to tailer send", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    // flag is NOT set → TCP hasn't delivered → tailer must send
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      {
        type: "relay_reply",
        content: "fallback",
        originChat: "-1003968796171",
      },
      6302,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("fallback");
  });

  test("relay_reply own-chat WITH suppressRelayReplyText skips send and resets flag", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    (state as any).suppressRelayReplyText = true; // TCP already delivered
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      {
        type: "relay_reply",
        content: "tcp-already-sent",
        originChat: "-1003968796171",
      },
      6302,
    );
    expect(sent).toHaveLength(0);
    expect((state as any).suppressRelayReplyText).toBe(false);
  });
});
