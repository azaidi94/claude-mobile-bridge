/**
 * Unit tests for src/topics/topic-store.ts.
 *
 * Uses CLAUDE_TELEGRAM_TOPICS_FILE env to point at a temp file so we
 * never touch the real store. Module is re-imported each test via
 * clearTopicStore() to reset in-memory state.
 */

// Bootstrap env — must run before any import that touches config.ts.
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "test-token";
process.env.TELEGRAM_ALLOWED_USERS =
  process.env.TELEGRAM_ALLOWED_USERS || "12345";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmpDir: string;
let storePath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "topic-store-test-"));
  storePath = join(tmpDir, "topics.json");
  process.env.CLAUDE_TELEGRAM_TOPICS_FILE = storePath;
});

afterEach(async () => {
  // Reset in-memory state
  const { clearTopicStore } = await import("../topics/topic-store");
  clearTopicStore();
  delete process.env.CLAUDE_TELEGRAM_TOPICS_FILE;
  await rm(tmpDir, { recursive: true, force: true });
});

function makeMapping(
  overrides: Partial<{
    topicId: number;
    sessionName: string;
    sessionDir: string;
    isOnline: boolean;
  }> = {},
) {
  return {
    topicId: overrides.topicId ?? 100,
    sessionName: overrides.sessionName ?? "test-session",
    sessionDir: overrides.sessionDir ?? "/tmp/test",
    isOnline: overrides.isOnline ?? true,
    createdAt: new Date().toISOString(),
  };
}

describe("topic-store", () => {
  test("starts empty", async () => {
    const { getTopicStore, clearTopicStore } =
      await import("../topics/topic-store");
    clearTopicStore();
    const store = getTopicStore();
    expect(store.chatId).toBe(0);
    expect(store.topics).toEqual([]);
  });

  test("addTopicMapping adds entry", async () => {
    const { addTopicMapping, getTopicStore, clearTopicStore } =
      await import("../topics/topic-store");
    clearTopicStore();
    const m = makeMapping();
    addTopicMapping(m);
    expect(getTopicStore().topics).toHaveLength(1);
    expect(getTopicStore().topics[0]!.sessionName).toBe("test-session");
  });

  test("removeTopicMapping removes by session name", async () => {
    const {
      addTopicMapping,
      removeTopicMapping,
      getTopicStore,
      clearTopicStore,
    } = await import("../topics/topic-store");
    clearTopicStore();
    addTopicMapping(makeMapping({ sessionName: "a" }));
    addTopicMapping(makeMapping({ sessionName: "b" }));
    expect(getTopicStore().topics).toHaveLength(2);

    removeTopicMapping("a");
    expect(getTopicStore().topics).toHaveLength(1);
    expect(getTopicStore().topics[0]!.sessionName).toBe("b");
  });

  test("getTopicBySession returns correct mapping", async () => {
    const { addTopicMapping, getTopicBySession, clearTopicStore } =
      await import("../topics/topic-store");
    clearTopicStore();
    addTopicMapping(makeMapping({ sessionName: "alpha", topicId: 1 }));
    addTopicMapping(makeMapping({ sessionName: "beta", topicId: 2 }));

    const result = getTopicBySession("beta");
    expect(result).toBeDefined();
    expect(result!.topicId).toBe(2);
  });

  test("getTopicBySession returns undefined for missing", async () => {
    const { getTopicBySession, clearTopicStore } =
      await import("../topics/topic-store");
    clearTopicStore();
    expect(getTopicBySession("nope")).toBeUndefined();
  });

  test("getSessionByTopic returns correct mapping", async () => {
    const { addTopicMapping, getSessionByTopic, clearTopicStore } =
      await import("../topics/topic-store");
    clearTopicStore();
    addTopicMapping(makeMapping({ sessionName: "alpha", topicId: 10 }));
    addTopicMapping(makeMapping({ sessionName: "beta", topicId: 20 }));

    const result = getSessionByTopic(20);
    expect(result).toBeDefined();
    expect(result!.sessionName).toBe("beta");
  });

  test("getSessionByTopic returns undefined for missing", async () => {
    const { getSessionByTopic, clearTopicStore } =
      await import("../topics/topic-store");
    clearTopicStore();
    expect(getSessionByTopic(999)).toBeUndefined();
  });

  test("updateTopicMapping updates fields", async () => {
    const {
      addTopicMapping,
      updateTopicMapping,
      getTopicBySession,
      clearTopicStore,
    } = await import("../topics/topic-store");
    clearTopicStore();
    addTopicMapping(makeMapping({ sessionName: "sess", topicId: 5 }));

    updateTopicMapping("sess", { isOnline: false });
    expect(getTopicBySession("sess")!.isOnline).toBe(false);
  });

  test("updateTopicMapping no-ops for missing session", async () => {
    const { updateTopicMapping, getTopicStore, clearTopicStore } =
      await import("../topics/topic-store");
    clearTopicStore();
    // Should not throw
    updateTopicMapping("nonexistent", { isOnline: false });
    expect(getTopicStore().topics).toHaveLength(0);
  });

  test("setChatId updates chatId", async () => {
    const { setChatId, getTopicStore, clearTopicStore } =
      await import("../topics/topic-store");
    clearTopicStore();
    setChatId(42);
    expect(getTopicStore().chatId).toBe(42);
  });

  test("save and load round-trips", async () => {
    const {
      addTopicMapping,
      setChatId,
      saveTopicStore,
      loadTopicStore,
      getTopicStore,
      clearTopicStore,
    } = await import("../topics/topic-store");
    clearTopicStore();

    setChatId(123);
    addTopicMapping(makeMapping({ sessionName: "s1", topicId: 1 }));
    addTopicMapping(makeMapping({ sessionName: "s2", topicId: 2 }));

    // Force immediate save (bypass debounce)
    await saveTopicStore();

    // Verify file exists on disk
    expect(existsSync(storePath)).toBe(true);
    const raw = JSON.parse(await readFile(storePath, "utf-8"));
    expect(raw.chatId).toBe(123);
    expect(raw.topics).toHaveLength(2);

    // Clear in-memory and reload
    clearTopicStore();
    expect(getTopicStore().topics).toHaveLength(0);

    await loadTopicStore();
    expect(getTopicStore().chatId).toBe(123);
    expect(getTopicStore().topics).toHaveLength(2);
    expect(getTopicStore().topics[0]!.sessionName).toBe("s1");
    expect(getTopicStore().topics[1]!.sessionName).toBe("s2");
  });

  test("saveTopicStore skips write when chatId is 0 (anti-pollution guard)", async () => {
    const { addTopicMapping, saveTopicStore, clearTopicStore } =
      await import("../topics/topic-store");
    clearTopicStore();

    // Simulate in-memory state with chatId still 0 (never detected a forum).
    // This is exactly the state that previously clobbered the production
    // ~/.claude-mobile-bridge/topics.json when a debounced save fired after
    // a test teardown removed the CLAUDE_TELEGRAM_TOPICS_FILE env override.
    addTopicMapping(makeMapping({ sessionName: "leaked", topicId: 99 }));

    await saveTopicStore();

    // File must NOT exist — the guard should have refused the write.
    expect(existsSync(storePath)).toBe(false);
  });

  test("loadTopicStore handles missing file gracefully", async () => {
    const { loadTopicStore, getTopicStore, clearTopicStore } =
      await import("../topics/topic-store");
    clearTopicStore();
    // storePath doesn't exist yet — should not throw
    await loadTopicStore();
    expect(getTopicStore().topics).toEqual([]);
  });

  test("multiple sessions in same dir (disambiguation)", async () => {
    const {
      addTopicMapping,
      getTopicBySession,
      getSessionByTopic,
      clearTopicStore,
    } = await import("../topics/topic-store");
    clearTopicStore();

    const sharedDir = "/home/user/project";
    addTopicMapping(
      makeMapping({
        sessionName: "proj-main",
        sessionDir: sharedDir,
        topicId: 10,
      }),
    );
    addTopicMapping(
      makeMapping({
        sessionName: "proj-feature",
        sessionDir: sharedDir,
        topicId: 20,
      }),
    );

    // Each maps to its own topic despite shared dir
    expect(getTopicBySession("proj-main")!.topicId).toBe(10);
    expect(getTopicBySession("proj-feature")!.topicId).toBe(20);
    expect(getSessionByTopic(10)!.sessionName).toBe("proj-main");
    expect(getSessionByTopic(20)!.sessionName).toBe("proj-feature");
  });

  test("getTopicByLaunchUuid finds by launchUuid and ignores falsy", async () => {
    const {
      addTopicMapping,
      getTopicByLaunchUuid,
      setChatId,
      clearTopicStore,
    } = await import("../topics/topic-store");
    clearTopicStore();
    setChatId(-100);
    addTopicMapping({
      topicId: 5,
      sessionName: "kx",
      sessionDir: "/k",
      sessionId: "s1",
      isOnline: true,
      createdAt: "t",
      launchUuid: "u1",
    });

    expect(getTopicByLaunchUuid("u1")?.topicId).toBe(5);
    expect(getTopicByLaunchUuid("")).toBeUndefined();
    expect(getTopicByLaunchUuid("nope")).toBeUndefined();
  });

  describe("topicForSession", () => {
    test("launchUuid hit wins even when a different topic has the passed sessionName", async () => {
      const { addTopicMapping, topicForSession, setChatId, clearTopicStore } =
        await import("../topics/topic-store");
      clearTopicStore();
      setChatId(-100);
      addTopicMapping({
        topicId: 5,
        sessionName: "other-session",
        sessionDir: "/k",
        isOnline: true,
        createdAt: "t",
        launchUuid: "U",
      });
      addTopicMapping({
        topicId: 6,
        sessionName: "wrong-name",
        sessionDir: "/j",
        isOnline: true,
        createdAt: "t",
      });

      const result = topicForSession({
        launchUuid: "U",
        sessionName: "wrong-name",
      });
      expect(result?.topicId).toBe(5);
    });

    test("launchUuid miss falls back to name lookup", async () => {
      const { addTopicMapping, topicForSession, setChatId, clearTopicStore } =
        await import("../topics/topic-store");
      clearTopicStore();
      setChatId(-100);
      addTopicMapping({
        topicId: 7,
        sessionName: "by-name",
        sessionDir: "/k",
        isOnline: true,
        createdAt: "t",
      });

      const result = topicForSession({
        launchUuid: "does-not-exist",
        sessionName: "by-name",
      });
      expect(result?.topicId).toBe(7);
    });

    test("no launchUuid falls back to name lookup", async () => {
      const { addTopicMapping, topicForSession, setChatId, clearTopicStore } =
        await import("../topics/topic-store");
      clearTopicStore();
      setChatId(-100);
      addTopicMapping({
        topicId: 8,
        sessionName: "by-name-2",
        sessionDir: "/k",
        isOnline: true,
        createdAt: "t",
      });

      const result = topicForSession({ sessionName: "by-name-2" });
      expect(result?.topicId).toBe(8);
    });
  });

  describe("topicForSessionId", () => {
    test("exact live-id match wins over a launchUuid pointing elsewhere", async () => {
      // sessionId-first: when a topic's sessionId equals the live id, it is
      // returned even if the passed launchUuid resolves to a different topic —
      // the exact match is authoritative and can't be overridden by a bad map.
      const { addTopicMapping, topicForSessionId, setChatId, clearTopicStore } =
        await import("../topics/topic-store");
      clearTopicStore();
      setChatId(-100);
      addTopicMapping({
        topicId: 1,
        sessionName: "a",
        sessionDir: "/k",
        isOnline: true,
        createdAt: "t",
        launchUuid: "U", // a stale/bad map could point live-sid here…
      });
      addTopicMapping({
        topicId: 2,
        sessionName: "b",
        sessionDir: "/k",
        sessionId: "live-sid", // …but this topic owns the live id
        isOnline: true,
        createdAt: "t",
      });
      expect(
        topicForSessionId({ launchUuid: "U", sessionId: "live-sid" })?.topicId,
      ).toBe(2);
    });

    test("recovers via launchUuid when the topic's sessionId is stale (exact match misses)", async () => {
      const { addTopicMapping, topicForSessionId, setChatId, clearTopicStore } =
        await import("../topics/topic-store");
      clearTopicStore();
      setChatId(-100);
      addTopicMapping({
        topicId: 5,
        sessionName: "s",
        sessionDir: "/k",
        sessionId: "old-sid", // stale (pre-/clear)
        isOnline: true,
        createdAt: "t",
        launchUuid: "U",
      });

      const result = topicForSessionId({
        launchUuid: "U",
        sessionId: "live-sid",
      });
      expect(result?.topicId).toBe(5);
    });

    test("no launchUuid falls back to the sibling-safe sessionId lookup", async () => {
      const { addTopicMapping, topicForSessionId, setChatId, clearTopicStore } =
        await import("../topics/topic-store");
      clearTopicStore();
      setChatId(-100);
      addTopicMapping({
        topicId: 9,
        sessionName: "s",
        sessionDir: "/k",
        sessionId: "sid-9",
        isOnline: true,
        createdAt: "t",
      });

      expect(topicForSessionId({ sessionId: "sid-9" })?.topicId).toBe(9);
      expect(topicForSessionId({ sessionId: "nope" })).toBeUndefined();
    });
  });
});
