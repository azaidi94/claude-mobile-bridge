/**
 * Unit tests for session lifecycle notifications, especially the
 * suppressDirNotifications mechanism that drops add/remove events for sessions
 * killed via /kill so the dying relay's lingering port file doesn't trigger a
 * spurious online → offline flap.
 */

import { describe, expect, test, beforeEach, mock } from "bun:test";
import type { Api } from "grammy";
import type { SessionInfo } from "../sessions/types";

mock.module("../sessions/watcher", () => ({
  getActiveSession: mock(() => null),
}));

import {
  registerChatId,
  removeChatId,
  getChatIds,
  createNotificationHandler,
  suppressDirNotifications,
} from "../sessions/notifications";

const TEST_CHAT_ID = 999_888_777;
const FLAP_BUFFER_MS = 2_000;

function makeFakeApi(): {
  api: Api;
  sendMessage: ReturnType<typeof mock>;
} {
  const sendMessage = mock(() => Promise.resolve({ message_id: 1 }));
  const api = { sendMessage } as unknown as Api;
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
