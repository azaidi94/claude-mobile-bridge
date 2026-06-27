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
  tmpDir = await mkdtemp(join(tmpdir(), "resolve-thread-test-"));
  process.env.CLAUDE_TELEGRAM_TOPICS_FILE = join(tmpDir, "topics.json");
  const { clearTopicStore, setChatId } = await import("../topics/topic-store");
  clearTopicStore();
  setChatId(CHAT);
});

afterEach(async () => {
  const { clearTopicStore } = await import("../topics/topic-store");
  clearTopicStore();
  delete process.env.CLAUDE_TELEGRAM_TOPICS_FILE;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("resolveWatchThread", () => {
  test("live store mapping wins over the captured threadId", async () => {
    const { addTopicMapping } = await import("../topics/topic-store");
    const { resolveWatchThread } =
      await import("../handlers/watch/outbound-thread");
    addTopicMapping(makeMapping({ sessionName: "S", topicId: 9 }));

    // Captured threadId is stale (3); the live binding is 9.
    expect(resolveWatchThread({ sessionName: "S", threadId: 3 })).toBe(9);
  });

  test("falls back to the captured threadId when the mapping is gone", async () => {
    const { resolveWatchThread } =
      await import("../handlers/watch/outbound-thread");
    expect(resolveWatchThread({ sessionName: "S", threadId: 3 })).toBe(3);
  });
});
