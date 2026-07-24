/**
 * Unit tests for session lifecycle notifications, especially the
 * suppressDirNotifications mechanism that drops add/remove events for sessions
 * killed via /kill so the dying relay's lingering port file doesn't trigger a
 * spurious online → offline flap.
 */

import "./ensure-test-env";
import { describe, expect, test, beforeEach, mock } from "bun:test";
import type { Api } from "grammy";
import type { SessionInfo } from "../sessions/types";

// The notify handler resolves the LIVE session at fire time to gate topic
// creation on a resolved sessionId. Default: every name resolves to a session
// with a non-empty id (so pre-existing tests behave as before). Individual
// tests override `getSessionImpl` to simulate id-less / vanished relays.
let getSessionImpl: (name: string) => SessionInfo | null = (name) => ({
  id: `id-${name}`,
  name,
  dir: `/tmp/${name}`,
  lastActivity: 0,
  source: "desktop",
});
mock.module("../sessions/watcher", () => ({
  getActiveSession: mock(() => null),
  getSession: (name: string) => getSessionImpl(name),
}));

// Stub the message bus — notifications.broadcast() now sends via the bus
// (step 6a). Tests still inspect a per-call "sendMessage" mock by routing the
// bus send through it so the existing assertions keep working.
let activeBusSink: ReturnType<typeof mock> | null = null;
mock.module("../messaging", () => ({
  getMessageBus: () => ({
    send: async (msg: {
      chatId: number;
      content: string;
      replyMarkup?: unknown;
    }) => {
      // Route the bus send through the test's sendMessage mock so existing
      // assertions like broadcastsContaining(sendMessage, "x") keep working.
      try {
        await activeBusSink?.(
          msg.chatId,
          msg.content,
          msg.replyMarkup
            ? { parse_mode: "HTML", reply_markup: msg.replyMarkup }
            : { parse_mode: "HTML" },
        );
        return { messageId: 1 };
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

import {
  registerChatId,
  removeChatId,
  getChatIds,
  createNotificationHandler,
  suppressDirNotifications,
  setSessionCleanupCallback,
  __setIdWaitTimingForTests,
} from "../sessions/notifications";

const TEST_CHAT_ID = 999_888_777;
const FLAP_BUFFER_MS = 2_000;

function makeFakeApi(): {
  api: Api;
  sendMessage: ReturnType<typeof mock>;
} {
  const sendMessage = mock(() => Promise.resolve({ message_id: 1 }));
  const api = { sendMessage } as unknown as Api;
  activeBusSink = sendMessage;
  return { api, sendMessage };
}

function makeSession(name: string, dir: string): SessionInfo {
  return {
    id: `id-${name}`,
    name,
    dir,
    lastActivity: Date.now(),
    source: "desktop",
  };
}

function broadcastsContaining(
  sendMessage: ReturnType<typeof mock>,
  needle: string,
): unknown[][] {
  return sendMessage.mock.calls.filter(
    (c: unknown[]) =>
      typeof c[1] === "string" && (c[1] as string).includes(needle),
  );
}

describe("notifications: suppressDirNotifications", () => {
  beforeEach(() => {
    registerChatId(TEST_CHAT_ID);
    // Reset the id resolver + timing to defaults between tests.
    getSessionImpl = (name) => ({
      id: `id-${name}`,
      name,
      dir: `/tmp/${name}`,
      lastActivity: 0,
      source: "desktop",
    });
    __setIdWaitTimingForTests(45_000, 2_000);
  });

  test("control: added event fires online broadcast after flap buffer", async () => {
    const { api, sendMessage } = makeFakeApi();
    const handler = createNotificationHandler(api);
    const session = makeSession("ctrl-online", "/tmp/ctrl-online-dir");

    handler({ added: [session], removed: [] });
    await Bun.sleep(FLAP_BUFFER_MS + 200);

    const calls = broadcastsContaining(sendMessage, "ctrl-online");
    expect(calls.length).toBe(1);
    expect(calls[0]![1]).toContain("online");
  });

  test("suppressed dir: added event is dropped", async () => {
    const { api, sendMessage } = makeFakeApi();
    const handler = createNotificationHandler(api);
    const session = makeSession("kill-add", "/tmp/kill-add-dir");

    suppressDirNotifications(session.dir);
    handler({ added: [session], removed: [] });
    await Bun.sleep(FLAP_BUFFER_MS + 200);

    expect(broadcastsContaining(sendMessage, "kill-add").length).toBe(0);
  });

  test("suppressed dir: removed event is dropped", async () => {
    const { api, sendMessage } = makeFakeApi();
    const handler = createNotificationHandler(api);
    const dir = "/tmp/kill-remove-dir";

    suppressDirNotifications(dir);
    handler({ added: [], removed: [{ name: "kill-remove", dir }] });
    await Bun.sleep(FLAP_BUFFER_MS + 200);

    expect(broadcastsContaining(sendMessage, "kill-remove").length).toBe(0);
  });

  test("suppressed removed still fires cleanup callback so orphan watches clear", async () => {
    const { api } = makeFakeApi();
    const handler = createNotificationHandler(api);
    const dir = "/tmp/kill-cleanup-dir";
    const cleaned: string[] = [];

    setSessionCleanupCallback((name) => cleaned.push(name));
    try {
      suppressDirNotifications(dir);
      handler({ added: [], removed: [{ name: "kill-cleanup", dir }] });
      // Cleanup fires synchronously on the suppressed branch, no flap wait.
      expect(cleaned).toEqual(["kill-cleanup"]);
    } finally {
      setSessionCleanupCallback(() => {});
    }
  });

  test("suppression cancels an already-pending notification", async () => {
    const { api, sendMessage } = makeFakeApi();
    const handler = createNotificationHandler(api);
    const session = makeSession("inflight", "/tmp/inflight-dir");

    // Queue an added notification first, then suppress before the flap fires.
    handler({ added: [session], removed: [] });
    suppressDirNotifications(session.dir);
    await Bun.sleep(FLAP_BUFFER_MS + 200);

    expect(broadcastsContaining(sendMessage, "inflight").length).toBe(0);
  });

  test("remove→add flap within buffer suppresses both broadcasts", async () => {
    const { api, sendMessage } = makeFakeApi();
    const handler = createNotificationHandler(api);
    const dir = "/tmp/flap-suppress-dir";

    // Session goes offline, then reappears within the flap buffer.
    handler({ added: [], removed: [{ name: "flap-suppress", dir }] });
    handler({ added: [makeSession("flap-suppress", dir)], removed: [] });
    await Bun.sleep(FLAP_BUFFER_MS + 200);

    expect(broadcastsContaining(sendMessage, "flap-suppress").length).toBe(0);
  });

  test("topic manager appearing during the flap buffer is used at fire time", async () => {
    const { api } = makeFakeApi();
    const createTopic = mock(() => Promise.resolve(4242));
    let manager:
      | { createTopic: typeof createTopic; deleteTopic: () => Promise<void> }
      | undefined;
    const handler = createNotificationHandler(
      api,
      () => manager as unknown as import("../topics").TopicManager | undefined,
    );

    handler({
      added: [makeSession("late-tm", "/tmp/late-tm-dir")],
      removed: [],
    });
    // Manager becomes available while the 2s flap buffer is still running
    // (fresh install: onForumGroupDetected fires after the first diff).
    manager = { createTopic, deleteTopic: () => Promise.resolve() };
    await Bun.sleep(FLAP_BUFFER_MS + 200);

    expect(createTopic).toHaveBeenCalledTimes(1);
  });

  test("broadcast drops chat id when Telegram returns chat not found", async () => {
    const stale = 777_666_001;
    const good = 777_666_002;
    removeChatId(stale);
    removeChatId(good);
    registerChatId(stale);
    registerChatId(good);

    const sendMessage = mock((chatId: number) => {
      if (chatId === stale) {
        return Promise.reject(
          new Error(
            "Call to 'sendMessage' failed! (400: Bad Request: chat not found)",
          ),
        );
      }
      return Promise.resolve({ message_id: 1 });
    });
    const api = { sendMessage } as unknown as Api;
    activeBusSink = sendMessage;
    const handler = createNotificationHandler(api);
    const session = makeSession("stale-drop", "/tmp/stale-drop-dir");

    handler({ added: [session], removed: [] });
    await Bun.sleep(FLAP_BUFFER_MS + 200);

    expect(getChatIds().has(stale)).toBe(false);
    expect(getChatIds().has(good)).toBe(true);
    // Broadcast targets every registered chat (including TEST_CHAT_ID from beforeEach).
    expect(broadcastsContaining(sendMessage, "stale-drop").length).toBe(3);

    removeChatId(good);
  });
});

describe("notifications: id-less relay gating", () => {
  beforeEach(() => {
    registerChatId(TEST_CHAT_ID);
    getSessionImpl = (name) => ({
      id: `id-${name}`,
      name,
      dir: `/tmp/${name}`,
      lastActivity: 0,
      source: "desktop",
    });
    __setIdWaitTimingForTests(45_000, 2_000);
  });

  function makeManager() {
    const createTopic = mock(() => Promise.resolve(4242));
    const manager = {
      createTopic,
      deleteTopic: () => Promise.resolve(),
    } as unknown as import("../topics").TopicManager;
    return { manager, createTopic };
  }

  test("id-less relay never creates a topic or online broadcast (skips after deadline)", async () => {
    const { api, sendMessage } = makeFakeApi();
    const { manager, createTopic } = makeManager();
    const handler = createNotificationHandler(api, () => manager);
    // Relay is present but never resolves a sessionId; deadline already elapsed
    // by the time the 2s flap timer fires, so it hits the give-up branch.
    getSessionImpl = (name) => ({
      id: "",
      name,
      dir: `/tmp/${name}`,
      lastActivity: 0,
      source: "desktop",
    });
    __setIdWaitTimingForTests(100, 50);

    handler({ added: [makeSession("phantom", "/tmp/phantom")], removed: [] });
    await Bun.sleep(FLAP_BUFFER_MS + 300);

    expect(createTopic).toHaveBeenCalledTimes(0);
    expect(broadcastsContaining(sendMessage, "phantom").length).toBe(0);
  });

  test("a relay that vanishes before resolving an id never creates a topic", async () => {
    const { api, sendMessage } = makeFakeApi();
    const { manager, createTopic } = makeManager();
    const handler = createNotificationHandler(api, () => manager);
    getSessionImpl = () => null; // gone by fire time

    handler({ added: [makeSession("vanished", "/tmp/vanished")], removed: [] });
    await Bun.sleep(FLAP_BUFFER_MS + 300);

    expect(createTopic).toHaveBeenCalledTimes(0);
    expect(broadcastsContaining(sendMessage, "vanished").length).toBe(0);
  });

  test("topic is created once an initially id-less relay resolves its sessionId", async () => {
    const { api, sendMessage } = makeFakeApi();
    const { manager, createTopic } = makeManager();
    const handler = createNotificationHandler(api, () => manager);
    // Start id-less, then stamp an id shortly after — the re-arm loop should
    // pick it up and create the topic exactly once.
    let resolved = false;
    getSessionImpl = (name) => ({
      id: resolved ? `id-${name}` : "",
      name,
      dir: `/tmp/${name}`,
      lastActivity: 0,
      source: "desktop",
    });
    __setIdWaitTimingForTests(5_000, 100);

    handler({ added: [makeSession("slow-id", "/tmp/slow-id")], removed: [] });
    setTimeout(() => {
      resolved = true;
    }, FLAP_BUFFER_MS + 250);
    await Bun.sleep(FLAP_BUFFER_MS + 700);

    expect(createTopic).toHaveBeenCalledTimes(1);
    expect(broadcastsContaining(sendMessage, "slow-id").length).toBe(1);
  });
});
