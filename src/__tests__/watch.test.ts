/**
 * Unit tests for watch handler state management and formatStatusMessage isWatching.
 *
 * Tests watch state lifecycle, isWatching/stopWatching helpers,
 * notifySessionOffline, and the new isWatching status format.
 */

import "./ensure-test-env";
import {
  describe,
  expect,
  test,
  mock,
  beforeAll,
  beforeEach,
  afterEach,
} from "bun:test";

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

// Mutable settings state so tests can tune getContextNotifyStep via saveSetting.
const _settingsState: { contextNotifyStep: number } = { contextNotifyStep: 0 };
mock.module("../settings", () => ({
  getWorkingDir: () => "/tmp/test-working-dir",
  getTerminal: () => "terminal" as const,
  getAutoWatchOnSpawn: () => true,
  getDefaultModelSetting: () => undefined,
  getOverrides: () => ({}),
  saveSetting: mock((patch: { contextNotifyStep?: number }) => {
    if (typeof patch?.contextNotifyStep === "number") {
      _settingsState.contextNotifyStep = patch.contextNotifyStep;
    }
    return Promise.resolve();
  }),
  _reloadForTests: mock(() => {}),
  getEnablePinnedStatus: () => true,
  getGroupModeSetting: () => undefined,
  getContextNotifyStep: () => _settingsState.contextNotifyStep,
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

describe("watch: handleTailEvent tool_result", () => {
  function makeMockApi() {
    const sent: Array<{ chatId: number | string; text: string }> = [];
    const api = {
      sendMessage: (chatId: number | string, text: string) => {
        sent.push({ chatId, text });
        return Promise.resolve({ message_id: 1 });
      },
      deleteMessage: () => Promise.resolve(true),
      sendChatAction: () => Promise.resolve(true),
    } as unknown as import("grammy").Api;
    return { api, sent };
  }

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

  test("tool_result for Bash promotes (sends combined message)", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    state.toolUseRegistry = new Map([["tu_x", "Bash"]]);
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      {
        type: "tool_result",
        content: "out",
        toolUseId: "tu_x",
        isError: false,
      },
      6302,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Bash");
  });

  test("tool_result for Bash strips trailing newline before picking last line", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    state.toolUseRegistry = new Map([["tu_b", "Bash"]]);
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      {
        type: "tool_result",
        content: "first line\nlast useful line\n",
        toolUseId: "tu_b",
        isError: false,
      },
      6302,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("last useful line");
    // Multi-line output should also advertise the extra-lines count.
    expect(sent[0]!.text).toContain("+1 lines");
  });

  test("tool_result for Read does NOT send (ephemeral, suppressed)", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    state.toolUseRegistry = new Map([["tu_y", "Read"]]);
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      {
        type: "tool_result",
        content: "file",
        toolUseId: "tu_y",
        isError: false,
      },
      6302,
    );
    expect(sent).toHaveLength(0);
  });

  test("tool_result with isError always promotes regardless of tool", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    state.toolUseRegistry = new Map([["tu_z", "Read"]]);
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      {
        type: "tool_result",
        content: "ENOENT",
        toolUseId: "tu_z",
        isError: true,
      },
      6302,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("ENOENT");
  });
});

describe("watch: handleTailEvent permission_mode", () => {
  function makeMockApi() {
    const sent: Array<{ chatId: number | string; text: string }> = [];
    const api = {
      sendMessage: (chatId: number | string, text: string) => {
        sent.push({ chatId, text });
        return Promise.resolve({ message_id: 1 });
      },
      deleteMessage: () => Promise.resolve(true),
      sendChatAction: () => Promise.resolve(true),
    } as unknown as import("grammy").Api;
    return { api, sent };
  }

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

  test("first permission_mode emits a message", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      { type: "permission_mode", content: "plan", permissionMode: "plan" },
      6302,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Plan mode");
  });

  test("duplicate consecutive permission_mode is deduplicated", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      { type: "permission_mode", content: "plan", permissionMode: "plan" },
      6302,
    );
    handleTailEvent(
      api,
      state,
      { type: "permission_mode", content: "plan", permissionMode: "plan" },
      6302,
    );
    expect(sent).toHaveLength(1);
  });

  test("permission_mode default is not emitted as a message", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      {
        type: "permission_mode",
        content: "default",
        permissionMode: "default",
      },
      6302,
    );
    expect(sent).toHaveLength(0);
  });

  test("plan → default → plan cycle re-emits the second plan", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      { type: "permission_mode", content: "plan", permissionMode: "plan" },
      6302,
    );
    handleTailEvent(
      api,
      state,
      {
        type: "permission_mode",
        content: "default",
        permissionMode: "default",
      },
      6302,
    );
    handleTailEvent(
      api,
      state,
      { type: "permission_mode", content: "plan", permissionMode: "plan" },
      6302,
    );
    expect(sent).toHaveLength(2);
    expect(sent[0]!.text).toContain("Plan mode");
    expect(sent[1]!.text).toContain("Plan mode");
  });
});

describe("watch: handleTailEvent hook_summary", () => {
  function makeMockApi() {
    const sent: Array<{ chatId: number | string; text: string }> = [];
    const api = {
      sendMessage: (chatId: number | string, text: string) => {
        sent.push({ chatId, text });
        return Promise.resolve({ message_id: 1 });
      },
      deleteMessage: () => Promise.resolve(true),
      sendChatAction: () => Promise.resolve(true),
    } as unknown as import("grammy").Api;
    return { api, sent };
  }

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

  test("hook_summary with errors emits a message", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      {
        type: "hook_summary",
        content: "lint failed",
        hook: {
          hookCount: 1,
          errorCount: 1,
          preventedContinuation: true,
          firstError: "lint failed",
          failingHookName: "lint",
        },
      },
      6302,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("lint");
    expect(sent[0]!.text).toContain("blocked");
  });
});

describe("context notify", () => {
  function makeMockApi() {
    const sent: Array<{
      chatId: number | string;
      text: string;
      opts?: unknown;
    }> = [];
    const api = {
      sendMessage: mock(
        (chatId: number | string, text: string, opts?: unknown) => {
          sent.push({ chatId, text, opts });
          return Promise.resolve({ message_id: 1 });
        },
      ),
      deleteMessage: () => Promise.resolve(true),
      sendChatAction: () => Promise.resolve(true),
    } as unknown as import("grammy").Api & {
      sendMessage: ReturnType<typeof mock>;
    };
    return { api, sent };
  }

  const makeWatchState = (
    chatId: number,
    threadId: number,
    lastNotifiedBucket: number,
    sessionId: string,
  ) =>
    ({
      chatId,
      threadId,
      sessionId,
      lastNotifiedBucket,
      // TailDisplayState minimum
      currentToolMsg: null,
      currentTextMsg: null,
      currentTextContent: "",
      lastTextUpdate: 0,
      segmentDone: true,
    }) as unknown as import("../handlers/watch").WatchState;

  test("fires once at first bucket crossing, silent on same-bucket next turn", async () => {
    const { saveSetting } = await import("../settings");
    await saveSetting({ contextNotifyStep: 25 });
    const { _resetRegistryForTests } =
      await import("../sessions/context-usage");
    _resetRegistryForTests();

    const { maybeNotifyContextCrossing } = await import("../handlers/watch");
    const { api, sent } = makeMockApi();
    const state = makeWatchState(1001, 42, 0, "sid-a");

    // 300_000 / 1M = 30% → bucket 25
    await maybeNotifyContextCrossing(api, state, {
      input_tokens: 300_000,
      output_tokens: 100,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Context 30%");
    expect(state.lastNotifiedBucket).toBe(25);

    // 350_000 / 1M = 35% → still bucket 25
    await maybeNotifyContextCrossing(api, state, {
      input_tokens: 350_000,
      output_tokens: 100,
    });
    expect(sent).toHaveLength(1);
  });

  test("step=0 never fires", async () => {
    const { saveSetting } = await import("../settings");
    await saveSetting({ contextNotifyStep: 0 });
    const { _resetRegistryForTests } =
      await import("../sessions/context-usage");
    _resetRegistryForTests();

    const { maybeNotifyContextCrossing } = await import("../handlers/watch");
    const { api, sent } = makeMockApi();
    const state = makeWatchState(1001, 42, 0, "sid-b");

    await maybeNotifyContextCrossing(api, state, {
      input_tokens: 900_000,
      output_tokens: 0,
    });
    expect(sent).toHaveLength(0);
  });

  test("compact resets bucket and re-arms", async () => {
    const { saveSetting } = await import("../settings");
    await saveSetting({ contextNotifyStep: 25 });
    const { _resetRegistryForTests } =
      await import("../sessions/context-usage");
    _resetRegistryForTests();

    const { maybeNotifyContextCrossing } = await import("../handlers/watch");
    const { api, sent } = makeMockApi();
    const state = makeWatchState(1001, 42, 50, "sid-c");

    // 5% — below prior bucket 50, resets to 0, no fire.
    await maybeNotifyContextCrossing(api, state, {
      input_tokens: 50_000,
      output_tokens: 0,
    });
    expect(sent).toHaveLength(0);
    expect(state.lastNotifiedBucket).toBe(0);

    // 30% — crosses 25 again → fires.
    await maybeNotifyContextCrossing(api, state, {
      input_tokens: 300_000,
      output_tokens: 0,
    });
    expect(sent).toHaveLength(1);
    expect(state.lastNotifiedBucket).toBe(25);
  });
});

describe("watch: handleTailEvent liveness typing", () => {
  // Asserting on chatActions count would be tautological for the stop tests:
  // the 4s heartbeat sleep prevents additional fires within a short test
  // window regardless of stop behavior. Inspect the typing-state map directly
  // via _isTypingForTests instead.
  let handleTailEvent: (typeof import("../handlers/watch"))["handleTailEvent"];
  let _resetWatchesForTests: (typeof import("../handlers/watch"))["_resetWatchesForTests"];
  let _isTypingForTests: (typeof import("../handlers/watch"))["_isTypingForTests"];

  beforeAll(async () => {
    const mod = await import("../handlers/watch");
    handleTailEvent = mod.handleTailEvent;
    _resetWatchesForTests = mod._resetWatchesForTests;
    _isTypingForTests = mod._isTypingForTests;
  });

  beforeEach(() => _resetWatchesForTests());
  afterEach(() => _resetWatchesForTests());

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
    const chatActions: Array<{ chatId: number; threadId?: number }> = [];
    const api = {
      sendMessage: () => Promise.resolve({ message_id: 1 }),
      deleteMessage: () => Promise.resolve(true),
      sendChatAction: (
        chatId: number,
        _action: string,
        opts?: { message_thread_id?: number },
      ) => {
        chatActions.push({ chatId, threadId: opts?.message_thread_id });
        return Promise.resolve(true);
      },
    } as unknown as import("grammy").Api;
    return { api, chatActions };
  }

  // Yield to the event loop so the typing loop's first sendChatAction lands.
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test("text event extends typing (was previously stop)", async () => {
    const state = makeState(-100, 6302, "/repo/x");
    const { api, chatActions } = makeMockApi();
    handleTailEvent(
      api,
      state,
      { type: "text", content: "streaming..." },
      6302,
    );
    await flush();
    expect(chatActions.length).toBeGreaterThan(0);
    expect(chatActions[0]!.threadId).toBe(6302);
  });

  test("tool_result event extends typing (was previously stop)", async () => {
    const state = makeState(-100, 6302, "/repo/x");
    const { api, chatActions } = makeMockApi();
    handleTailEvent(
      api,
      state,
      { type: "tool_result", content: "ok", toolUseId: "tu_1" },
      6302,
    );
    await flush();
    expect(chatActions.length).toBeGreaterThan(0);
  });

  test("usage event extends typing (was previously stop)", async () => {
    const state = makeState(-100, 6302, "/repo/x");
    const { api, chatActions } = makeMockApi();
    handleTailEvent(
      api,
      state,
      {
        type: "usage",
        content: "",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      6302,
    );
    await flush();
    expect(chatActions.length).toBeGreaterThan(0);
  });

  test("turn_end stops typing", async () => {
    const state = makeState(-100, 6302, "/repo/x");
    const { api } = makeMockApi();
    handleTailEvent(
      api,
      state,
      { type: "tool", content: "Reading", toolName: "Read" },
      6302,
    );
    await flush();
    handleTailEvent(api, state, { type: "turn_end", content: "" }, 6302);
    expect(_isTypingForTests(-100, 6302)).toBe(false);
  });

  test("turn_boundary stops typing", async () => {
    const state = makeState(-100, 6302, "/repo/x");
    const { api } = makeMockApi();
    handleTailEvent(api, state, { type: "user", content: "hi" }, 6302);
    await flush();
    handleTailEvent(api, state, { type: "turn_boundary", content: "" }, 6302);
    expect(_isTypingForTests(-100, 6302)).toBe(false);
  });
});

describe("watch: formatRunElapsedLabel", () => {
  test("seconds (< 60s)", async () => {
    const { formatRunElapsedLabel } = await import("../handlers/watch");
    expect(formatRunElapsedLabel(0)).toBe("0s");
    expect(formatRunElapsedLabel(15_000)).toBe("15s");
    expect(formatRunElapsedLabel(59_400)).toBe("59s");
  });

  test("minutes (< 60m)", async () => {
    const { formatRunElapsedLabel } = await import("../handlers/watch");
    expect(formatRunElapsedLabel(60_000)).toBe("1m");
    expect(formatRunElapsedLabel(150_000)).toBe("3m");
    expect(formatRunElapsedLabel(59 * 60_000)).toBe("59m");
  });

  test("hours (>= 60m)", async () => {
    const { formatRunElapsedLabel } = await import("../handlers/watch");
    expect(formatRunElapsedLabel(3_600_000)).toBe("1.0h");
    expect(formatRunElapsedLabel(5_400_000)).toBe("1.5h");
    expect(formatRunElapsedLabel(7_200_000)).toBe("2.0h");
  });
});

describe("watch: markPendingRunCompletion / clearPendingRunCompletion", () => {
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

  test("returns 'no-watch' when no WatchState exists", async () => {
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();
    expect(mod.markPendingRunCompletion(-100, 99, "x")).toBe("no-watch");
  });

  test("returns 'armed' on first call and stores prompt + startedAt", async () => {
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();
    const state = makeState(-100, 1, "/repo/a");
    mod._registerWatchForTests(state);

    const before = Date.now();
    expect(mod.markPendingRunCompletion(-100, 1, "do work")).toBe("armed");
    const w = mod._getWatchForTests(-100, 1)!;
    expect(w.pendingRunCompletion?.prompt).toBe("do work");
    expect(w.pendingRunCompletion!.startedAt).toBeGreaterThanOrEqual(before);
    // Watchdog reset side-effects.
    expect(w.midTurn).toBe(true);
    expect(w.watchdogFired).toBe(false);
  });

  test("returns 'already-pending' on second call without overwriting the first", async () => {
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();
    mod._registerWatchForTests(makeState(-100, 1, "/repo/a"));

    expect(mod.markPendingRunCompletion(-100, 1, "first")).toBe("armed");
    const firstStart = mod._getWatchForTests(-100, 1)!.pendingRunCompletion!
      .startedAt;
    expect(mod.markPendingRunCompletion(-100, 1, "second")).toBe(
      "already-pending",
    );
    const w = mod._getWatchForTests(-100, 1)!;
    expect(w.pendingRunCompletion?.prompt).toBe("first");
    expect(w.pendingRunCompletion!.startedAt).toBe(firstStart);
  });

  test("clearPendingRunCompletion frees the slot for a retry", async () => {
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();
    mod._registerWatchForTests(makeState(-100, 1, "/repo/a"));

    expect(mod.markPendingRunCompletion(-100, 1, "first")).toBe("armed");
    expect(mod.markPendingRunCompletion(-100, 1, "second")).toBe(
      "already-pending",
    );
    mod.clearPendingRunCompletion(-100, 1);
    expect(mod.markPendingRunCompletion(-100, 1, "second")).toBe("armed");
    expect(mod._getWatchForTests(-100, 1)!.pendingRunCompletion?.prompt).toBe(
      "second",
    );
  });

  test("clearPendingRunCompletion is a no-op when no watch exists", async () => {
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();
    expect(() => mod.clearPendingRunCompletion(-100, 99)).not.toThrow();
  });
});

describe("watch: startWatchdog idempotency", () => {
  test("startWatchdog called twice creates only one timer", async () => {
    const mod = await import("../handlers/watch");
    const fakeApi = {} as import("grammy").Api;
    // Stop first in case prior tests started it.
    mod.stopWatchdog();
    mod.startWatchdog(fakeApi);
    mod.startWatchdog(fakeApi); // idempotent — no second timer
    // Stopping once must fully disarm; a leaked second timer would keep ticking.
    mod.stopWatchdog();
    // Re-arm and disarm to confirm the cleanup path stays valid.
    mod.startWatchdog(fakeApi);
    mod.stopWatchdog();
  });
});

describe("watch: handleIdleWatch (notify-only branch)", () => {
  // WATCHDOG_AUTO_CONTINUE is read once at module load and defaults to false
  // in the test env, so this suite covers the notify-only branch. The
  // auto-continue branch is exercised by integration / live verification per
  // the PR test plan.
  const makeWatchState = (
    chatId: number,
    threadId: number,
  ): import("../handlers/watch").WatchState => ({
    chatId,
    threadId,
    sessionName: "idle-sess",
    sessionId: "sid-idle",
    sessionDir: "/repo/idle",
    currentToolMsg: null,
    currentTextMsg: null,
    currentTextContent: "last assistant text",
    lastTextUpdate: 0,
    segmentDone: false,
    lastEventTime: Date.now() - 11 * 60 * 1000, // 11 minutes ago
    midTurn: true,
    watchdogFired: false,
    tailer: { stop: () => {} } as any,
  });

  test("sends a notify-only ping with idle minutes and last-said quote", async () => {
    const mod = await import("../handlers/watch");
    const sent: Array<{ chatId: number | string; text: string; opts?: any }> =
      [];
    const api = {
      sendMessage: (chatId: number | string, text: string, opts?: any) => {
        sent.push({ chatId, text, opts });
        return Promise.resolve({ message_id: 1 });
      },
    } as unknown as import("grammy").Api;

    mod._handleIdleWatchForTests(api, makeWatchState(-100, 6302));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("idle");
    expect(sent[0]!.text).toContain("idle-sess");
    expect(sent[0]!.text).toContain("last said");
    expect(sent[0]!.opts?.message_thread_id).toBe(6302);
  });

  test("omits the last-said quote when no buffered text is present", async () => {
    const mod = await import("../handlers/watch");
    const sent: Array<{ text: string }> = [];
    const api = {
      sendMessage: (_c: any, text: string) => {
        sent.push({ text });
        return Promise.resolve({ message_id: 1 });
      },
    } as unknown as import("grammy").Api;

    const state = makeWatchState(-100, 6302);
    state.currentTextContent = "";
    mod._handleIdleWatchForTests(api, state);

    expect(sent[0]!.text).not.toContain("last said");
  });
});
