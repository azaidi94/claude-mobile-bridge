/**
 * Race fixed: brand-new Claude sessions show up in the relay port file
 * before their JSONL has a parseable first line, so initial scans return
 * SessionInfo with id="". startAutoWatch used to give up immediately; it
 * now polls via _awaitSessionId and re-checks intent before binding.
 */

import "./ensure-test-env";
import { describe, expect, test, mock, beforeEach } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
let lastExcludeIds: unknown;
let scanPortFilesImpl: () => Promise<any[]> = async () => [];

mock.module("../relay", () => ({
  scanPortFiles: () => scanPortFilesImpl(),
  getRelayClient: async () => null,
}));

mock.module("../sessions/tailer", () => ({
  findSessionJsonlPath: (id: string) => findSessionJsonlPathImpl(id),
  findNewestSessionInDir: (dir: string, excludeIds?: ReadonlySet<string>) => {
    lastExcludeIds = excludeIds;
    return findNewestSessionInDirImpl(dir, excludeIds);
  },
  getExpectedJsonlPath: (cwd: string, id: string) =>
    `/expected/${cwd.replace(/[/.]/g, "-")}/${id}.jsonl`,
  encodeProjectPath: (cwd: string) => cwd.replace(/[/.]/g, "-"),
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

  test("with a sibling sharing the dir: never adopts the newest-in-dir JSONL", async () => {
    // The sibling's file IS the newest in the dir, but the freshly-spawned
    // target's own file hasn't landed yet. allowNewestInDirFallback=false must
    // keep us speculative on the canonical id rather than binding the sibling.
    findSessionJsonlPathImpl = async (id) =>
      id === "sibling-uuid" ? "/proj/sibling-uuid.jsonl" : null;
    findNewestSessionInDirImpl = async () => "sibling-uuid";

    const { _resolveLiveJsonlPath } = await import("../handlers/watch");
    const result = await _resolveLiveJsonlPath(SESSION, {
      timeoutMs: 60,
      intervalMs: 20,
      allowNewestInDirFallback: false,
    });

    expect(result.sessionId).toBe(SESSION.id); // NOT "sibling-uuid"
    expect(result.speculative).toBe(true);
    expect(result.path).toContain(SESSION.id);
  });

  test("forwards excludeIds to the newest-in-dir probe", async () => {
    lastExcludeIds = undefined;
    findSessionJsonlPathImpl = async () => null;
    findNewestSessionInDirImpl = async () => null;
    const exclude = new Set(["sibling-uuid"]);

    const { _resolveLiveJsonlPath } = await import("../handlers/watch");
    await _resolveLiveJsonlPath(SESSION, {
      timeoutMs: 40,
      intervalMs: 20,
      excludeIds: exclude,
    });

    expect(lastExcludeIds).toBe(exclude);
  });
});

describe("inspectDirSiblings", () => {
  beforeEach(async () => {
    scanPortFilesImpl = async () => [];
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();
  });

  test("flags a sibling and collects its id from a co-located port file", async () => {
    scanPortFilesImpl = async () => [
      { cwd: "/dir", sessionId: "own-id", sessionName: "a" },
      { cwd: "/dir", sessionId: "sibling-id", sessionName: "b" },
      { cwd: "/other", sessionId: "unrelated", sessionName: "c" },
    ];
    const { inspectDirSiblings } = await import("../handlers/watch");
    const { excludeIds, hasSibling } = await inspectDirSiblings(
      "/dir",
      "own-id",
    );
    expect(hasSibling).toBe(true);
    expect(excludeIds.has("sibling-id")).toBe(true);
    expect(excludeIds.has("own-id")).toBe(false);
    expect(excludeIds.has("unrelated")).toBe(false);
  });

  test("no sibling when the dir is solo", async () => {
    scanPortFilesImpl = async () => [
      { cwd: "/dir", sessionId: "own-id", sessionName: "a" },
    ];
    const { inspectDirSiblings } = await import("../handlers/watch");
    const { hasSibling } = await inspectDirSiblings("/dir", "own-id");
    expect(hasSibling).toBe(false);
  });
});

describe("_recoverMisboundTailer", () => {
  const fakeBotApi = {} as never;

  const makeWatch = (over: Record<string, unknown>): any => ({
    chatId: 1,
    threadId: 2,
    sessionName: "sess-2",
    sessionId: "sibling-id",
    sessionDir: "/dir",
    currentToolMsg: null,
    currentTextMsg: null,
    currentTextContent: "",
    lastTextUpdate: 0,
    segmentDone: true,
    lastEventTime: Date.now(),
    tailer: { stop: () => {} },
    ...over,
  });

  beforeEach(async () => {
    scanPortFilesImpl = async () => [];
    findSessionJsonlPathImpl = async () => null;
    getSessionImpl = () => null;
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();
  });

  test("rebinds a sibling-bound watch to its canonical id once that file exists", async () => {
    // Our watch is tailing the sibling's JSONL; the sibling owns it per the
    // port files. The registry knows our real id, and its file is now on disk.
    getSessionImpl = (name) =>
      name === "sess-2" ? ({ id: "own-id" } as any) : null;
    scanPortFilesImpl = async () => [
      { cwd: "/dir", sessionId: "sibling-id", sessionName: "sess-1" },
      { cwd: "/dir", sessionId: "own-id", sessionName: "sess-2" },
    ];
    findSessionJsonlPathImpl = async (id) =>
      id === "own-id" ? "/proj/own-id.jsonl" : null;

    const mod = await import("../handlers/watch");
    const ws = makeWatch({ sessionId: "sibling-id" });
    mod._registerWatchForTests(ws);

    const recovered = await mod._recoverMisboundTailer(fakeBotApi, ws);
    expect(recovered).toBe(true);
    expect(ws.sessionId).toBe("own-id");
  });

  test("no-op when already bound to the canonical id", async () => {
    getSessionImpl = () => ({ id: "own-id" }) as any;
    const mod = await import("../handlers/watch");
    const ws = makeWatch({ sessionId: "own-id" });
    mod._registerWatchForTests(ws);

    expect(await mod._recoverMisboundTailer(fakeBotApi, ws)).toBe(false);
    expect(ws.sessionId).toBe("own-id");
  });

  test("no-op for a legitimate /clear drift (bound id owned by no sibling)", async () => {
    // watchState.sessionId is our own fresh-conversation id: no port file or
    // sibling watch claims it, so it must not be reverted to the stale id.
    getSessionImpl = () => ({ id: "stale-port-id" }) as any;
    scanPortFilesImpl = async () => [
      { cwd: "/dir", sessionId: "stale-port-id", sessionName: "sess-2" },
    ];
    findSessionJsonlPathImpl = async () => "/proj/stale-port-id.jsonl";

    const mod = await import("../handlers/watch");
    const ws = makeWatch({ sessionId: "fresh-clear-id" });
    mod._registerWatchForTests(ws);

    expect(await mod._recoverMisboundTailer(fakeBotApi, ws)).toBe(false);
    expect(ws.sessionId).toBe("fresh-clear-id");
  });

  test("recovers under a full mutual swap (sibling itself mis-bound to our id)", async () => {
    // Watch X tails id-2; watch Y tails id-1; canonical(X)=id-1, canonical(Y)=id-2.
    // Y "holds" id-1 (X's target) but is itself mis-bound, so it must not block X.
    getSessionImpl = (name) =>
      name === "X"
        ? ({ id: "id-1" } as any)
        : name === "Y"
          ? ({ id: "id-2" } as any)
          : null;
    scanPortFilesImpl = async () => [
      { cwd: "/dir", sessionId: "id-1", sessionName: "X" },
      { cwd: "/dir", sessionId: "id-2", sessionName: "Y" },
    ];
    findSessionJsonlPathImpl = async (id) => `/proj/${id}.jsonl`;

    const mod = await import("../handlers/watch");
    const wx = makeWatch({ sessionName: "X", sessionId: "id-2" });
    const wy = makeWatch({ sessionName: "Y", sessionId: "id-1", threadId: 3 });
    mod._registerWatchForTests(wx);
    mod._registerWatchForTests(wy);

    expect(await mod._recoverMisboundTailer(fakeBotApi, wx)).toBe(true);
    expect(wx.sessionId).toBe("id-1");
  });

  test("yields to a sibling watch that legitimately holds the canonical id", async () => {
    // Y correctly owns id-1 (canonical(Y)=id-1); X must not steal it.
    getSessionImpl = (name) =>
      name === "X"
        ? ({ id: "id-1" } as any)
        : name === "Y"
          ? ({ id: "id-1" } as any)
          : null;
    scanPortFilesImpl = async () => [
      { cwd: "/dir", sessionId: "id-2", sessionName: "other" },
    ];
    findSessionJsonlPathImpl = async (id) => `/proj/${id}.jsonl`;

    const mod = await import("../handlers/watch");
    const wx = makeWatch({ sessionName: "X", sessionId: "id-2" });
    const wy = makeWatch({ sessionName: "Y", sessionId: "id-1", threadId: 3 });
    mod._registerWatchForTests(wx);
    mod._registerWatchForTests(wy);

    expect(await mod._recoverMisboundTailer(fakeBotApi, wx)).toBe(false);
    expect(wx.sessionId).toBe("id-2");
  });

  test("no-op when the canonical file is not yet on disk", async () => {
    getSessionImpl = () => ({ id: "own-id" }) as any;
    scanPortFilesImpl = async () => [
      { cwd: "/dir", sessionId: "sibling-id", sessionName: "sess-1" },
    ];
    findSessionJsonlPathImpl = async () => null; // own-id file absent

    const mod = await import("../handlers/watch");
    const ws = makeWatch({ sessionId: "sibling-id" });
    mod._registerWatchForTests(ws);

    expect(await mod._recoverMisboundTailer(fakeBotApi, ws)).toBe(false);
    expect(ws.sessionId).toBe("sibling-id");
  });
});

describe("_resolveDriftTargetId", () => {
  const makeWatch = (over: Record<string, unknown>): any => ({
    chatId: 7,
    threadId: 1,
    sessionName: "sess",
    sessionId: "cur",
    sessionDir: "/dir",
    sessionPid: 100,
    currentToolMsg: null,
    currentTextMsg: null,
    currentTextContent: "",
    lastTextUpdate: 0,
    segmentDone: true,
    lastEventTime: Date.now(),
    tailer: { stop: () => {} },
    ...over,
  });

  beforeEach(async () => {
    scanPortFilesImpl = async () => [];
    findNewestSessionInDirImpl = async () => null;
    getSessionImpl = () => null;
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();
  });

  test("sole owner: follows the newest JSONL in the dir", async () => {
    findNewestSessionInDirImpl = async () => "newest-clear-id";
    const mod = await import("../handlers/watch");
    const ws = makeWatch({});
    mod._registerWatchForTests(ws);
    expect(await mod._resolveDriftTargetId(ws)).toBe("newest-clear-id");
  });

  test("shared dir: uses the port file matched by this session's pid (not newest-in-dir)", async () => {
    scanPortFilesImpl = async () => [
      { cwd: "/dir", ppid: 100, sessionId: "my-live-id" },
      { cwd: "/dir", ppid: 200, sessionId: "sibling-live-id" },
    ];
    // newest-in-dir would mis-attribute to the sibling; it must NOT be consulted.
    findNewestSessionInDirImpl = async () => "sibling-live-id";
    const mod = await import("../handlers/watch");
    const ws = makeWatch({ sessionPid: 100 });
    const sibling = makeWatch({
      threadId: 2,
      sessionName: "sess2",
      sessionPid: 200,
    });
    mod._registerWatchForTests(ws);
    mod._registerWatchForTests(sibling);
    expect(await mod._resolveDriftTargetId(ws)).toBe("my-live-id");
  });

  test("shared dir: keeps the current id (no flap) when this pid has no port file", async () => {
    // Relay for this pid is down / scan returned no match. Must NOT drag the
    // tailer onto a divergent cache id — that flaps and spams "🔄".
    scanPortFilesImpl = async () => [
      { cwd: "/dir", ppid: 999, sessionId: "unrelated" },
    ];
    getSessionImpl = (name) =>
      name === "sess" ? ({ id: "divergent-cache-id" } as any) : null;
    const mod = await import("../handlers/watch");
    const ws = makeWatch({ sessionPid: 100, sessionId: "cur" });
    const sibling = makeWatch({
      threadId: 2,
      sessionName: "sess2",
      sessionPid: 200,
    });
    mod._registerWatchForTests(ws);
    mod._registerWatchForTests(sibling);
    expect(await mod._resolveDriftTargetId(ws)).toBe("cur");
  });

  test("shared dir: keeps the current id when scanPortFiles throws", async () => {
    scanPortFilesImpl = async () => {
      throw new Error("scan boom");
    };
    getSessionImpl = () => ({ id: "divergent-cache-id" }) as any;
    const mod = await import("../handlers/watch");
    const ws = makeWatch({ sessionPid: 100, sessionId: "cur" });
    const sibling = makeWatch({
      threadId: 2,
      sessionName: "sess2",
      sessionPid: 200,
    });
    mod._registerWatchForTests(ws);
    mod._registerWatchForTests(sibling);
    expect(await mod._resolveDriftTargetId(ws)).toBe("cur");
  });

  test("shared dir with unknown pid: falls back to the cache id", async () => {
    scanPortFilesImpl = async () => [
      { cwd: "/dir", ppid: 200, sessionId: "sibling-live-id" },
    ];
    getSessionImpl = () => ({ id: "cache-id" }) as any;
    const mod = await import("../handlers/watch");
    const ws = makeWatch({ sessionPid: undefined });
    const sibling = makeWatch({
      threadId: 2,
      sessionName: "sess2",
      sessionPid: 200,
    });
    mod._registerWatchForTests(ws);
    mod._registerWatchForTests(sibling);
    expect(await mod._resolveDriftTargetId(ws)).toBe("cache-id");
  });

  test("shared dir with unknown pid and no cache entry: keeps current id", async () => {
    scanPortFilesImpl = async () => [];
    getSessionImpl = () => null;
    const mod = await import("../handlers/watch");
    const ws = makeWatch({ sessionPid: undefined, sessionId: "cur" });
    const sibling = makeWatch({
      threadId: 2,
      sessionName: "sess2",
      sessionPid: 200,
    });
    mod._registerWatchForTests(ws);
    mod._registerWatchForTests(sibling);
    expect(await mod._resolveDriftTargetId(ws)).toBe("cur");
  });
});

describe("_isBackwardDriftTarget (anti-flap guard)", () => {
  // Regression: an old relay's discovery loop oscillated its port file's
  // sessionId between two stale transcripts every 15s; the drift loop followed
  // each flip and spammed "🔄 started a new conversation" into the topic.
  // Rolling onto a JSONL whose last activity predates the tailed one must be
  // refused.
  const dir = mkdtempSync(join(tmpdir(), "drift-mtime-"));
  const stalePath = join(dir, "stale.jsonl");
  const freshPath = join(dir, "fresh.jsonl");
  writeFileSync(stalePath, "{}\n");
  writeFileSync(freshPath, "{}\n");
  utimesSync(stalePath, new Date(1_000_000), new Date(1_000_000));
  utimesSync(freshPath, new Date(2_000_000), new Date(2_000_000));

  test("true when the drift target is staler than the tailed JSONL (flap back)", async () => {
    findSessionJsonlPathImpl = async (id) => (id === "prev" ? freshPath : null);
    const mod = await import("../handlers/watch");
    expect(await mod._isBackwardDriftTarget(stalePath, "prev")).toBe(true);
  });

  test("false for a genuine forward roll", async () => {
    findSessionJsonlPathImpl = async (id) => (id === "prev" ? stalePath : null);
    const mod = await import("../handlers/watch");
    expect(await mod._isBackwardDriftTarget(freshPath, "prev")).toBe(false);
  });

  test("false when the previous path is unknown (speculative tailer)", async () => {
    findSessionJsonlPathImpl = async () => null;
    const mod = await import("../handlers/watch");
    expect(await mod._isBackwardDriftTarget(stalePath, "prev")).toBe(false);
  });

  test("false when the target can't be statted — only a proven backward roll skips", async () => {
    findSessionJsonlPathImpl = async () => freshPath;
    const mod = await import("../handlers/watch");
    expect(
      await mod._isBackwardDriftTarget(join(dir, "missing.jsonl"), "prev"),
    ).toBe(false);
  });
});
