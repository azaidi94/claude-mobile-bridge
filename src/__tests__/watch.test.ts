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
  enforceToolSafety: async () => ({}),
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
  getWatchImages: () => true,
  getVerboseLevel: () => 1,
  getGroupModeSetting: () => undefined,
  getContextNotifyStep: () => _settingsState.contextNotifyStep,
}));

// ---------------------------------------------------------------------------
// Bus mock — phase-2 step-4 routes watch sends through getMessageBus().send.
// Tests assert on a `sent[]` array populated by both `api.sendMessage` (legacy
// path, e.g. typing actions or tests that still inject directly) and the bus.
// `_setBusSink` is called by each describe's `makeMockApi` helper so the bus
// mock pushes into that test's local `sent[]`.
// ---------------------------------------------------------------------------
type _BusSink = Array<{
  chatId: number | string;
  text: string;
  opts?: unknown;
}>;
let _currentBusSink: _BusSink | null = null;
function _setBusSink(sink: _BusSink): void {
  _currentBusSink = sink;
}
let _busMessageIdCounter = 50_000;
mock.module("../messaging", () => ({
  getMessageBus: () => ({
    send: (m: {
      chatId: number;
      threadId?: number;
      content: string;
      format?: string;
      silent?: boolean;
    }) => {
      const opts: Record<string, unknown> = {};
      if (m.format === "html") opts.parse_mode = "HTML";
      else if (m.format === "markdown") opts.parse_mode = "MarkdownV2";
      if (m.threadId !== undefined) opts.message_thread_id = m.threadId;
      if (m.silent) opts.disable_notification = true;
      _currentBusSink?.push({ chatId: m.chatId, text: m.content, opts });
      return Promise.resolve({ messageId: ++_busMessageIdCounter });
    },
    edit: (
      messageId: number,
      m: {
        chatId: number;
        threadId?: number;
        content: string;
        format?: string;
      },
    ) => {
      const opts: Record<string, unknown> = {};
      if (m.format === "html") opts.parse_mode = "HTML";
      if (m.threadId !== undefined) opts.message_thread_id = m.threadId;
      // Edits don't show up in `sent[]` assertions historically (they targeted
      // editMessageText, not sendMessage). Skip pushing to keep counts stable.
      void messageId;
      void opts;
      return Promise.resolve({ ok: true as const });
    },
  }),
  setMessageBus: () => {},
  createMessageBus: () => ({ send: () => Promise.resolve({ messageId: 0 }) }),
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
    const sink: _BusSink = [];
    _setBusSink(sink);
    const ctx = {
      from: { id: 123 },
      chat: { id: 456 },
      message: {}, // no message_thread_id
      reply: (_text: string) => Promise.resolve(),
    } as any;

    await handleWatch(ctx);
    expect(sink.length).toBe(1);
    expect(sink[0]!.text).toContain("per-topic");
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
    _setBusSink(sent);
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

  test("user event with originChat === ownChat is skipped (TCP dedup) — and does NOT emit to bus (bug_010)", async () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    const { globalEventBus } = await import("../web/sse");
    const received: import("../web/sse").SseEvent[] = [];
    const unsub = globalEventBus.subscribe("s-6302", (evt) =>
      received.push(evt),
    );
    handleTailEvent(
      api,
      state,
      { type: "user", content: "hi", originChat: "-1003968796171" },
      6302,
    );
    expect(sent).toHaveLength(0);
    // text.ts is the single emitter for own-chat TG input — handleTailEvent
    // must NOT also emit, otherwise the Web UI shows two '📱 Telegram' panes.
    expect(received).toHaveLength(0);
    unsub();
  });

  test("user event with originChat === 'web' is skipped (already on bus)", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      { type: "user", content: "hmmm", originChat: "web" },
      6302,
    );
    expect(sent).toHaveLength(0);
  });

  test("user event with originChat undefined emits terminal user_message to bus", async () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    const { globalEventBus } = await import("../web/sse");
    const received: import("../web/sse").SseEvent[] = [];
    const unsub = globalEventBus.subscribe("s-6302", (evt) =>
      received.push(evt),
    );
    handleTailEvent(
      api,
      state,
      { type: "user", content: "native input" },
      6302,
    );
    unsub();
    expect(sent).toHaveLength(0);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "user_message",
      source: "terminal",
      content: "native input",
    });
  });

  test("user event with <task-notification> XML renders as a card, not raw XML", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    const xml = [
      "<task-notification>",
      "<task-id>bxds11oof</task-id>",
      "<tool-use-id>toolu_01abc</tool-use-id>",
      "<output-file>/tmp/out.txt</output-file>",
      "<status>completed</status>",
      '<summary>Background command "npx expo prebuild --clean" finished</summary>',
      "</task-notification>",
    ].join("\n");
    handleTailEvent(api, state, { type: "user", content: xml }, 6302);
    expect(sent).toHaveLength(1);
    const text = sent[0]!.text as string;
    expect(text).toContain("✅");
    expect(text).toContain("Task completed");
    expect(text).toContain("npx expo prebuild --clean");
    expect(text).not.toContain("<task-notification>");
    expect(text).not.toContain("<output-file>");
    expect(text).not.toContain("toolu_01abc");
  });

  test("user event with <task-notification> renders <event> detail under the summary", () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    const xml = [
      "<task-notification>",
      "<task-id>b6gssymeb</task-id>",
      '<summary>Monitor event: "Haiku eval run progress"</summary>',
      "<event>haiku progress: 48/58 scenarios</event>",
      "</task-notification>",
    ].join("\n");
    handleTailEvent(api, state, { type: "user", content: xml }, 6302);
    expect(sent).toHaveLength(1);
    const text = sent[0]!.text as string;
    expect(text).toContain("Monitor event:");
    expect(text).toContain("haiku progress: 48/58 scenarios");
    expect(text).not.toContain("<event>");
  });

  test("user event that is entirely <local-command-caveat> is dropped (no send, no bus emit)", async () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    const { globalEventBus } = await import("../web/sse");
    const received: import("../web/sse").SseEvent[] = [];
    const unsub = globalEventBus.subscribe("s-6302", (evt) =>
      received.push(evt),
    );
    const xml =
      "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>";
    handleTailEvent(api, state, { type: "user", content: xml }, 6302);
    unsub();
    expect(sent).toHaveLength(0);
    expect(received).toHaveLength(0);
  });

  test("user event with caveat prefix + real text strips the caveat", async () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    const { globalEventBus } = await import("../web/sse");
    const received: import("../web/sse").SseEvent[] = [];
    const unsub = globalEventBus.subscribe("s-6302", (evt) =>
      received.push(evt),
    );
    const xml =
      "<local-command-caveat>blah</local-command-caveat>\nhello there";
    handleTailEvent(api, state, { type: "user", content: xml }, 6302);
    unsub();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "user_message",
      source: "terminal",
      content: "hello there",
    });
  });

  test("user event with <task-notification> does NOT emit to the bus", async () => {
    const state = makeState(-1003968796171, 6302, "/repo/x");
    const { api } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    const { globalEventBus } = await import("../web/sse");
    const received: import("../web/sse").SseEvent[] = [];
    const unsub = globalEventBus.subscribe("s-6302", (evt) =>
      received.push(evt),
    );
    const xml = [
      "<task-notification>",
      "<status>completed</status>",
      "<summary>x finished</summary>",
      "</task-notification>",
    ].join("\n");
    handleTailEvent(api, state, { type: "user", content: xml }, 6302);
    unsub();
    expect(received).toHaveLength(0);
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
    _setBusSink(sent);
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
    // Simulate TCP having claimed this turn before the tailer fired.
    const { turnClaimKey } = require("../handlers/watch/turn-claims");
    const claims = new Map<string, number>();
    claims.set(turnClaimKey("hello"), Date.now() + 5 * 60 * 1000);
    (state as any).relayReplyClaims = claims;
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
    // Simulate TCP having claimed this turn before the tailer fired.
    const { turnClaimKey } = require("../handlers/watch/turn-claims");
    const claims = new Map<string, number>();
    claims.set(turnClaimKey("hello"), Date.now() + 5 * 60 * 1000);
    (state as any).relayReplyClaims = claims;
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

  test("relay_reply own-chat with a matching turn claim skips send and consumes the claim", () => {
    const {
      turnClaimKey,
      claimTurn,
    } = require("../handlers/watch/turn-claims");
    const state = makeState(-1003968796171, 6302, "/repo/x");
    // TCP path claimed this turn synchronously before its async send.
    const claims = new Map<string, number>();
    (state as any).relayReplyClaims = claims;
    claimTurn(claims, turnClaimKey("tcp-already-sent"));

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
    // Tailer sees the claim → skips its fallback send and consumes the claim
    // so a later turn with identical text is not suppressed.
    expect(sent).toHaveLength(0);
    expect(claims.has(turnClaimKey("tcp-already-sent"))).toBe(false);
  });
});

describe("watch: handleTailEvent tool_result", () => {
  function makeMockApi() {
    const sent: Array<{ chatId: number | string; text: string }> = [];
    _setBusSink(sent as _BusSink);
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
    _setBusSink(sent as _BusSink);
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
    _setBusSink(sent as _BusSink);
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
    _setBusSink(sent);
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
    _setBusSink([]); // typing tests don't assert on sent text
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
    _setBusSink(sent as _BusSink);
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
    _setBusSink(sent as _BusSink);
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

describe("watch: handleTailEvent ask_user_question render", () => {
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
      opts?: any;
    }> = [];
    _setBusSink(sent);
    const deleted: Array<{ chatId: number | string; messageId: number }> = [];
    const api = {
      sendMessage: (chatId: number | string, text: string, opts?: any) => {
        sent.push({ chatId, text, opts });
        return Promise.resolve({ message_id: sent.length });
      },
      deleteMessage: (chatId: number | string, messageId: number) => {
        deleted.push({ chatId, messageId });
        return Promise.resolve(true);
      },
      sendChatAction: () => Promise.resolve(true),
    } as unknown as import("grammy").Api;
    return { api, sent, deleted };
  }

  test("renders ask_user_question as formatted card with HTML parse_mode", () => {
    const state = makeState(-100, 6302, "/repo/x");
    const { api, sent } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      {
        type: "ask_user_question",
        content: "",
        questions: [
          {
            question: "Pick a database?",
            options: [
              { label: "Postgres", description: "Strong" },
              { label: "SQLite" },
            ],
          },
        ],
      },
      6302,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("❓");
    expect(sent[0]!.text).toContain("Claude is asking");
    expect(sent[0]!.text).toContain("Pick a database?");
    expect(sent[0]!.text).toContain("Postgres");
    expect(sent[0]!.text).toContain("SQLite");
    expect(sent[0]!.text).not.toContain("🔧 AskUserQuestion");
    expect(sent[0]!.opts?.parse_mode).toBe("HTML");
    expect(sent[0]!.opts?.message_thread_id).toBe(6302);
  });

  test("subsequent tool event deletes the AUQ card (cycle-out)", async () => {
    const state = makeState(-100, 6302, "/repo/x");
    const { api, sent, deleted } = makeMockApi();
    const { handleTailEvent } = require("../handlers/watch");
    handleTailEvent(
      api,
      state,
      {
        type: "ask_user_question",
        content: "",
        questions: [
          {
            question: "Pick?",
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      },
      6302,
    );
    // Wait one microtask for the sendMessage promise to resolve and assign
    // currentToolMsg.
    await new Promise((r) => setTimeout(r, 0));
    expect(state.currentToolMsg).not.toBeNull();
    const auqMsgId = state.currentToolMsg.message_id;

    handleTailEvent(
      api,
      state,
      { type: "tool", content: "🔧 Read file.ts", toolName: "Read" },
      6302,
    );
    expect(deleted).toContainEqual({ chatId: -100, messageId: auqMsgId });
  });
});

describe("cross-post subscription", () => {
  test("forwards web user_message to Telegram but not telegram source", async () => {
    const { SessionEventBus } = await import("../web/sse");
    const { setupCrossPostSubscription } = await import("../handlers/watch");
    const bus = new SessionEventBus();
    const sink: _BusSink = [];
    _setBusSink(sink);
    const mockApi = {
      sendMessage: () => Promise.resolve({ message_id: 1 }),
    } as unknown as import("grammy").Api;
    const calls = sink;

    const fakeWatchState = {
      chatId: 100,
      threadId: 42,
      sessionName: "my-session",
    } as unknown as import("../handlers/watch").WatchState;

    setupCrossPostSubscription(mockApi, fakeWatchState, bus);

    bus.emit("my-session", {
      type: "user_message",
      source: "web",
      content: "hello from web",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.chatId).toBe(100);
    expect(calls[0]!.text).toContain("hello from web");
    expect(calls[0]!.opts).toMatchObject({ message_thread_id: 42 });

    calls.length = 0;
    bus.emit("my-session", {
      type: "user_message",
      source: "telegram",
      content: "hello from tg",
    });
    expect(calls).toHaveLength(0);

    calls.length = 0;
    bus.emit("my-session", { type: "text", content: "response" });
    expect(calls).toHaveLength(0);

    fakeWatchState.unsubCrossPost?.();
  });

  test("unsubCrossPost stops forwarding after cleanup", async () => {
    const { SessionEventBus } = await import("../web/sse");
    const { setupCrossPostSubscription } = await import("../handlers/watch");
    const bus = new SessionEventBus();
    const calls: _BusSink = [];
    _setBusSink(calls);
    const mockApi = {
      sendMessage: () => Promise.resolve({ message_id: 1 }),
    } as unknown as import("grammy").Api;

    const fakeWatchState = {
      chatId: 100,
      threadId: 42,
      sessionName: "my-session",
    } as unknown as import("../handlers/watch").WatchState;

    setupCrossPostSubscription(mockApi, fakeWatchState, bus);
    expect(typeof fakeWatchState.unsubCrossPost).toBe("function");

    bus.emit("my-session", {
      type: "user_message",
      source: "web",
      content: "first",
    });
    expect(calls).toHaveLength(1);

    // Simulate cleanupWatch path: unsubscribe, then verify no further forwards.
    fakeWatchState.unsubCrossPost?.();

    bus.emit("my-session", {
      type: "user_message",
      source: "web",
      content: "after-unsub",
    });
    expect(calls).toHaveLength(1);
  });

  test("truncates long content before sending to Telegram", async () => {
    const { SessionEventBus } = await import("../web/sse");
    const { setupCrossPostSubscription } = await import("../handlers/watch");
    const bus = new SessionEventBus();
    const calls: _BusSink = [];
    _setBusSink(calls);
    const mockApi = {
      sendMessage: () => Promise.resolve({ message_id: 1 }),
    } as unknown as import("grammy").Api;

    const fakeWatchState = {
      chatId: 100,
      threadId: 42,
      sessionName: "my-session",
    } as unknown as import("../handlers/watch").WatchState;

    setupCrossPostSubscription(mockApi, fakeWatchState, bus);

    const long = "x".repeat(5000);
    bus.emit("my-session", {
      type: "user_message",
      source: "web",
      content: long,
    });

    expect(calls).toHaveLength(1);
    const sentText = calls[0]!.text;
    expect(sentText.length).toBeLessThan(400);
    expect(sentText.endsWith("…")).toBe(true);

    fakeWatchState.unsubCrossPost?.();
  });
});
