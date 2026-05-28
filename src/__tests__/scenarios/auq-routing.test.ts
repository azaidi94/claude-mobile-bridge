/**
 * S4 — AUQ bridge resolves the right topic from the session's cwd.
 *
 * The AUQ PreToolUse hook posts {request_id, cwd, questions} to the bot.
 * The bot routes the card to the topic whose sessionDir matches that cwd.
 * If the lookup is wrong, the card lands in the wrong topic (or none).
 *
 * Locks down the topic-by-cwd lookup that gates AUQ delivery.
 */

import { setupIsolatedStateDir, teardownStateDir } from "./_helpers";

const STATE_DIR = setupIsolatedStateDir();

import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  afterAll,
} from "bun:test";
const { getTopicBySessionDir } = await import("../../topics");
const { setChatId, addTopicMapping, removeTopicMapping } =
  await import("../../topics/topic-store");

const CHAT_ID = -1008888888888;
const CC_TOPIC_A = 70;
const CC_TOPIC_B = 71;
const CC_DIR_A = "/tmp/__phase0_s4_a__";
const CC_DIR_B = "/tmp/__phase0_s4_b__";

beforeEach(() => {
  setChatId(CHAT_ID);
  addTopicMapping({
    topicId: CC_TOPIC_A,
    sessionName: "s4-a",
    sessionDir: CC_DIR_A,
    sessionId: "aaaa-uuid",
    isOnline: true,
    createdAt: new Date().toISOString(),
  });
  addTopicMapping({
    topicId: CC_TOPIC_B,
    sessionName: "s4-b",
    sessionDir: CC_DIR_B,
    sessionId: "bbbb-uuid",
    isOnline: true,
    createdAt: new Date().toISOString(),
  });
});

afterEach(() => {
  removeTopicMapping("s4-a");
  removeTopicMapping("s4-b");
});

afterAll(() => {
  teardownStateDir(STATE_DIR);
});

describe("S4 — AUQ topic-by-cwd routing", () => {
  test("lookup by cwd A returns topic A", () => {
    const topic = getTopicBySessionDir(CC_DIR_A);
    expect(topic).toBeDefined();
    expect(topic!.topicId).toBe(CC_TOPIC_A);
    expect(topic!.sessionName).toBe("s4-a");
  });

  test("lookup by cwd B returns topic B (no cross-routing)", () => {
    const topic = getTopicBySessionDir(CC_DIR_B);
    expect(topic).toBeDefined();
    expect(topic!.topicId).toBe(CC_TOPIC_B);
  });

  test("unknown cwd returns undefined (AUQ route will 404)", () => {
    const topic = getTopicBySessionDir("/tmp/__nonexistent__");
    expect(topic).toBeUndefined();
  });
});
