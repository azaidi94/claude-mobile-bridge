/**
 * S1 — Text in a CC-bound topic resolves to the right CC session.
 *
 * Locks down the topic → session resolution behaviour Phase 1 must preserve:
 * when a topic is mapped to a CC session, `loadTopicSession(ctx)` returns a
 * `sessionOverride` carrying THAT session's id+dir+pid, regardless of what
 * other sessions are active in the registry.
 */

import {
  setupIsolatedStateDir,
  teardownStateDir,
  makeContext,
  writeFakeJsonl,
  cleanupProjectDir,
} from "./_helpers";

const STATE_DIR = setupIsolatedStateDir();

import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  afterAll,
} from "bun:test";
const { loadTopicSession, isSessionTopic } = await import("../../topics");
const { setChatId, addTopicMapping, removeTopicMapping } =
  await import("../../topics/topic-store");
const { addTelegramSession, updateSessionId, removeSession, addCursorSession } =
  await import("../../sessions");

const CHAT_ID = -1001234567890;
const USER_ID = 12345;
const CC_TOPIC = 42;
const CC_NAME = "phase0-s1-cc";
const CC_ID = "11111111-2222-3333-4444-555555555555";
const CC_CWD = "/tmp/__phase0_s1_cc__";

beforeEach(() => {
  setChatId(CHAT_ID);
  writeFakeJsonl(CC_CWD, CC_ID);
  addTelegramSession(CC_CWD, CC_NAME);
  updateSessionId(CC_NAME, CC_ID);
  addTopicMapping({
    topicId: CC_TOPIC,
    sessionName: CC_NAME,
    sessionDir: CC_CWD,
    sessionId: CC_ID,
    isOnline: true,
    createdAt: new Date().toISOString(),
  });
});

afterEach(() => {
  removeTopicMapping(CC_NAME);
  removeSession(CC_NAME);
});

afterAll(() => {
  teardownStateDir(STATE_DIR);
  cleanupProjectDir(CC_CWD);
});

describe("S1 — text in a CC topic", () => {
  test("isSessionTopic returns the CC session mapping", () => {
    const ctx = makeContext({
      chatId: CHAT_ID,
      userId: USER_ID,
      threadId: CC_TOPIC,
      text: "hello",
    });
    const topicCtx = isSessionTopic(ctx as never);
    expect(topicCtx).not.toBeNull();
    expect(topicCtx!.sessionName).toBe(CC_NAME);
    expect(topicCtx!.topicId).toBe(CC_TOPIC);
  });

  test("loadTopicSession returns sessionOverride with the topic's CC session", () => {
    const ctx = makeContext({
      chatId: CHAT_ID,
      userId: USER_ID,
      threadId: CC_TOPIC,
      text: "hello",
    });
    const result = loadTopicSession(ctx as never);
    expect(result).toBeDefined();
    expect(result!.threadId).toBe(CC_TOPIC);
    expect(result!.sessionOverride).toBeDefined();
    expect(result!.sessionOverride!.sessionId).toBe(CC_ID);
    expect(result!.sessionOverride!.sessionDir).toBe(CC_CWD);
  });

  test("resolution is unaffected by a later, more-recently-active Cursor session", () => {
    // Simulate the bug condition: a Cursor session was just touched, so its
    // lastActivity timestamp is newer than the CC session's. This is what
    // hijacked getActiveSession() in the recent photo bug.
    addCursorSession({ name: "cursor-other", dir: "/tmp/__cursor_other__" });

    const ctx = makeContext({
      chatId: CHAT_ID,
      userId: USER_ID,
      threadId: CC_TOPIC,
      text: "hello",
    });
    const result = loadTopicSession(ctx as never);
    expect(result!.sessionOverride!.sessionId).toBe(CC_ID);
    expect(result!.sessionOverride!.sessionDir).toBe(CC_CWD);

    removeSession("cursor-other");
  });

  test("non-topic context returns undefined", () => {
    const ctx = makeContext({
      chatId: CHAT_ID,
      userId: USER_ID,
      threadId: undefined,
      chatType: "private",
      text: "hello",
    });
    const result = loadTopicSession(ctx as never);
    expect(result).toBeUndefined();
  });

  test("General topic (thread_id=1) returns undefined", () => {
    const ctx = makeContext({
      chatId: CHAT_ID,
      userId: USER_ID,
      threadId: 1,
      text: "hello",
    });
    const result = loadTopicSession(ctx as never);
    expect(result).toBeUndefined();
  });
});
