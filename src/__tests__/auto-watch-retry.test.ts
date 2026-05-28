/**
 * Race fixed: brand-new Claude sessions show up in the relay port file
 * before their JSONL has a parseable first line, so initial scans return
 * SessionInfo with id="". startAutoWatch used to give up immediately; it
 * now polls via _awaitSessionId and re-checks intent before binding.
 */

import "./ensure-test-env";
import { describe, expect, test, mock, beforeEach } from "bun:test";
import type { SessionInfo } from "../sessions/types";

let getSessionImpl: (name: string) => SessionInfo | null = () => null;
let forceRefreshCalls = 0;
let findSessionJsonlPathImpl: (
  id: string,
) => Promise<string | null> = async () => null;
let findNewestSessionInDirImpl: (
  dir: string,
  excludeIds?: ReadonlySet<string>,
) => Promise<string | null> = async () => null;

mock.module("../sessions/tailer", () => ({
  findSessionJsonlPath: (id: string) => findSessionJsonlPathImpl(id),
  findNewestSessionInDir: (dir: string, excludeIds?: ReadonlySet<string>) =>
    findNewestSessionInDirImpl(dir, excludeIds),
  getExpectedJsonlPath: (cwd: string, id: string) =>
    `/expected/${cwd.replace(/[/.]/g, "-")}/${id}.jsonl`,
  SessionTailer: class {
    constructor(
      public path: string,
      public cb: (event: unknown) => void,
    ) {}
    async start() {}
    stop() {}
  },
}));

mock.module("../sessions", () => ({
  getSession: (name: string) => getSessionImpl(name),
  forceRefresh: async () => {
    forceRefreshCalls++;
  },
  // Re-export the rest as no-ops to satisfy transitive imports.
  startWatcher: async () => {},
  stopWatcher: () => {},
  getSessions: () => [],
  getActiveSession: () => null,
  setActiveSession: () => false,
  addTelegramSession: () => null,
  updateSessionId: () => {},
  updateSessionActivity: () => {},
  removeSession: () => false,
  registerChatId: () => {},
  removeChatId: () => {},
  loadChatIds: async () => {},
  createNotificationHandler: () => () => {},
  getChatIds: () => new Set(),
  setSessionOfflineCallback: () => {},
  suppressDirNotifications: () => {},
  SessionTailer: class {},
  findSessionJsonlPath: async () => null,
  loadPinnedMessageIds: async () => {},
  getPinnedMessageId: () => undefined,
  setPinnedMessageId: () => {},
  clearPinnedMessageId: () => {},
  formatStatusMessage: () => "",
  updatePinnedStatus: async () => {},
  removePinnedStatus: async () => {},
  getGitBranch: async () => null,
  getRecentHistory: () => [],
  formatHistoryMessage: () => "",
  sendSwitchHistory: async () => {},
  resolveSessionContext: () => undefined,
  getSessionState: () => ({
    sessionName: null,
    workingDir: "/tmp",
    isPlanMode: false,
    isRunning: false,
    loadFromRegistry: () => {},
  }),
  dropSessionState: () => {},
}));

const SESSION: SessionInfo = {
  id: "uuid-1",
  name: "AHZ_Claw",
  dir: "/Users/azaidi/Projects/Cursor/AHZ/AHZ_Claw",
  lastActivity: Date.now(),
  source: "desktop",
};

const SESSION_NO_ID: SessionInfo = { ...SESSION, id: "" };

describe("_awaitSessionId", () => {
  beforeEach(() => {
    forceRefreshCalls = 0;
  });

  test("returns immediately when session id is already populated", async () => {
    getSessionImpl = () => SESSION;
    const { _awaitSessionId } = await import("../handlers/watch");
    const result = await _awaitSessionId("AHZ_Claw", [10, 10, 10]);
    expect(result?.id).toBe("uuid-1");
    expect(forceRefreshCalls).toBe(1);
  });

  test("retries until id resolves, then returns the session", async () => {
    let calls = 0;
    getSessionImpl = () => {
      calls++;
      return calls >= 3 ? SESSION : SESSION_NO_ID;
    };
    const { _awaitSessionId } = await import("../handlers/watch");
    const result = await _awaitSessionId("AHZ_Claw", [10, 10, 10]);
    expect(result?.id).toBe("uuid-1");
    expect(calls).toBe(3);
    expect(forceRefreshCalls).toBe(3);
  });

  test("returns null after exhausting retries", async () => {
    getSessionImpl = () => SESSION_NO_ID;
    const { _awaitSessionId } = await import("../handlers/watch");
    const result = await _awaitSessionId("AHZ_Claw", [5, 5]);
    expect(result).toBeNull();
    expect(forceRefreshCalls).toBe(3); // 1 initial + 2 retries
  });

  test("returns null when session disappears mid-retry", async () => {
    let calls = 0;
    getSessionImpl = () => {
      calls++;
      return calls === 1 ? SESSION_NO_ID : null;
    };
    const { _awaitSessionId } = await import("../handlers/watch");
    const result = await _awaitSessionId("AHZ_Claw", [5, 5, 5]);
    expect(result).toBeNull();
  });
});

describe("startAutoWatch intent-preservation guards", () => {
  const CHAT_ID = 1001;
  const THREAD_ID = 42;
  const fakeBotApi = {} as never;

  const makeWatchState = (sessionName: string): any => ({
    chatId: CHAT_ID,
    threadId: THREAD_ID,
    sessionName,
    sessionId: "existing-id",
    sessionDir: "/tmp/x",
    currentToolMsg: null,
    currentTextMsg: null,
    currentTextContent: "",
    lastTextUpdate: 0,
    segmentDone: true,
    lastEventTime: Date.now(),
    tailer: { stop: () => {} },
  });

  beforeEach(async () => {
    forceRefreshCalls = 0;
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();
  });

  test("pre-wait: bails immediately when topic already bound to different session", async () => {
    getSessionImpl = () => SESSION;
    const mod = await import("../handlers/watch");
    const preExisting = makeWatchState("other-session");
    mod._registerWatchForTests(preExisting);

    const result = await mod.startAutoWatch(
      fakeBotApi,
      CHAT_ID,
      THREAD_ID,
      "AHZ_Claw",
    );

    expect(result).toBe(false);
    expect(forceRefreshCalls).toBe(0);
    expect(mod._getWatchForTests(CHAT_ID, THREAD_ID)).toBe(preExisting);
  });

  test("post-wait: stands down when different session gets bound during wait", async () => {
    findSessionJsonlPathImpl = async () => null;
    findNewestSessionInDirImpl = async () => null;
    const mod = await import("../handlers/watch");
    const racingWatch = makeWatchState("user-picked");
    getSessionImpl = () => {
      if (!mod._getWatchForTests(CHAT_ID, THREAD_ID)) {
        mod._registerWatchForTests(racingWatch);
      }
      return SESSION;
    };

    const result = await mod.startAutoWatch(
      fakeBotApi,
      CHAT_ID,
      THREAD_ID,
      "AHZ_Claw",
    );

    expect(result).toBe(false);
    expect(forceRefreshCalls).toBe(1);
    expect(mod._getWatchForTests(CHAT_ID, THREAD_ID)).toBe(racingWatch);
  });
});

describe("_resolveLiveJsonlPath (auto-watch path resolver)", () => {
  beforeEach(() => {
    findSessionJsonlPathImpl = async () => null;
    findNewestSessionInDirImpl = async () => null;
  });

  test("direct hit: returns the canonical id's path, not speculative", async () => {
    findSessionJsonlPathImpl = async (id) => `/proj/${id}.jsonl`;
    const { _resolveLiveJsonlPath } = await import("../handlers/watch");
    const result = await _resolveLiveJsonlPath(SESSION, {
      timeoutMs: 50,
      intervalMs: 5,
    });
    expect(result.speculative).toBe(false);
    expect(result.sessionId).toBe(SESSION.id);
    expect(result.path).toBe(`/proj/${SESSION.id}.jsonl`);
  });

  test("polls dir for real JSONL when canonical id never appears", async () => {
    // Direct path lookup keeps returning null. After a tick, the newest-in-dir
    // probe returns a *different* uuid — simulating CC writing under a fresh
    // id rather than the port file's id.
    let dirCalls = 0;
    findNewestSessionInDirImpl = async () => {
      dirCalls++;
      if (dirCalls < 2) return null;
      return "real-uuid";
    };
    findSessionJsonlPathImpl = async (id) =>
      id === "real-uuid" ? "/proj/real-uuid.jsonl" : null;

    const { _resolveLiveJsonlPath } = await import("../handlers/watch");
    const result = await _resolveLiveJsonlPath(SESSION, {
      timeoutMs: 1_000,
      intervalMs: 20,
    });
    expect(result.speculative).toBe(false);
    expect(result.sessionId).toBe("real-uuid");
    expect(result.path).toBe("/proj/real-uuid.jsonl");
  });

  test("falls back to expected path with speculative=true when nothing appears", async () => {
    findSessionJsonlPathImpl = async () => null;
    findNewestSessionInDirImpl = async () => null;
    const { _resolveLiveJsonlPath } = await import("../handlers/watch");
    const result = await _resolveLiveJsonlPath(SESSION, {
      timeoutMs: 60,
      intervalMs: 20,
    });
    expect(result.speculative).toBe(true);
    expect(result.sessionId).toBe(SESSION.id);
    expect(result.path).toContain(SESSION.id);
  });
});
