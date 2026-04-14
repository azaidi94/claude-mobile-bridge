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
});
