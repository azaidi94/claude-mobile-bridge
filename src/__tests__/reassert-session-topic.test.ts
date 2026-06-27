process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "test-token";
process.env.TELEGRAM_ALLOWED_USERS =
  process.env.TELEGRAM_ALLOWED_USERS || "12345";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { TopicMapping } from "../types";

let tmpDir: string;
const CHAT = 555;

function makeMapping(over: Partial<TopicMapping> = {}): TopicMapping {
  return {
    topicId: 100,
    sessionName: "proj-main",
    sessionDir: "/home/me/proj",
    isOnline: true,
    createdAt: "2026-06-27T00:00:00.000Z",
    ...over,
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "reassert-test-"));
  process.env.CLAUDE_TELEGRAM_TOPICS_FILE = join(tmpDir, "topics.json");
  const { clearTopicStore, setChatId } = await import("../topics/topic-store");
  clearTopicStore();
  setChatId(CHAT);
  const { _resetWatchesForTests } = await import("../handlers/watch");
  _resetWatchesForTests();
});

afterEach(async () => {
  const { clearTopicStore } = await import("../topics/topic-store");
  clearTopicStore();
  const { _resetWatchesForTests } = await import("../handlers/watch");
  _resetWatchesForTests();
  delete process.env.CLAUDE_TELEGRAM_TOPICS_FILE;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("reassertSessionTopic", () => {
  test("diverged store mapping is rebound to the origin topic", async () => {
    const { addTopicMapping, getTopicBySession } =
      await import("../topics/topic-store");
    const { reassertSessionTopic } = await import("../handlers/watch");
    addTopicMapping(makeMapping({ sessionName: "S", topicId: 3 }));

    reassertSessionTopic("S", CHAT, 7);

    expect(getTopicBySession("S")?.topicId).toBe(7);
  });

  test("aligned store mapping is left untouched (idempotent)", async () => {
    const { addTopicMapping, getTopicBySession } =
      await import("../topics/topic-store");
    const { reassertSessionTopic } = await import("../handlers/watch");
    addTopicMapping(makeMapping({ sessionName: "S", topicId: 7 }));

    reassertSessionTopic("S", CHAT, 7);

    expect(getTopicBySession("S")?.topicId).toBe(7);
  });

  test("a live watch bound to the wrong topic is moved to the origin", async () => {
    const { addTopicMapping } = await import("../topics/topic-store");
    const { buildWatchState } = await import("../handlers/watch");
    const { _registerWatchForTests, _getWatchForTests } =
      await import("../handlers/watch");
    const { reassertSessionTopic } = await import("../handlers/watch");
    addTopicMapping(makeMapping({ sessionName: "S", topicId: 3 }));
    _registerWatchForTests(
      buildWatchState({
        sessionName: "S",
        sessionId: "uuid-s",
        sessionDir: "/home/me/proj",
        chatId: CHAT,
        threadId: 3,
      }),
    );

    reassertSessionTopic("S", CHAT, 7);

    expect(_getWatchForTests(CHAT, 3)).toBeUndefined();
    const moved = _getWatchForTests(CHAT, 7);
    expect(moved?.sessionName).toBe("S");
    expect(moved?.threadId).toBe(7);
  });
});
