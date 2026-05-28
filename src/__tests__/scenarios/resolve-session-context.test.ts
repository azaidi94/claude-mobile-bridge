/**
 * Phase 1 — `resolveSessionContext` characterisation.
 *
 * The new explicit-session resolver. Same contract as the old
 * `loadTopicSession`, but returns a typed SessionContext with `source`
 * disambiguated and no side effect on the singleton.
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
const { resolveSessionContext } = await import("../../sessions");
const { setChatId, addTopicMapping, removeTopicMapping } =
  await import("../../topics/topic-store");
const { addTelegramSession, updateSessionId, addCursorSession, removeSession } =
  await import("../../sessions");

const CHAT_ID = -1007777777777;
const CC_TOPIC = 50;
const CC_NAME = "p1-cc";
const CC_ID = "00000000-1111-2222-3333-444444444444";
const CC_CWD = "/tmp/__p1_cc__";

const CURSOR_TOPIC = 60;
const CURSOR_NAME = "cursor-p1";

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
  addCursorSession({ name: CURSOR_NAME, dir: "/Users/test" });
  addTopicMapping({
    topicId: CURSOR_TOPIC,
    sessionName: CURSOR_NAME,
    sessionDir: "/Users/test",
    sessionId: CURSOR_NAME,
    isOnline: true,
    createdAt: new Date().toISOString(),
  });
});

afterEach(() => {
  removeTopicMapping(CC_NAME);
  removeTopicMapping(CURSOR_NAME);
  removeSession(CC_NAME);
  removeSession(CURSOR_NAME);
});

afterAll(() => {
  teardownStateDir(STATE_DIR);
  cleanupProjectDir(CC_CWD);
});

describe("resolveSessionContext", () => {
  test("CC topic returns a CC context with the right ids", () => {
    const ctx = makeContext({
      chatId: CHAT_ID,
      userId: 1,
      threadId: CC_TOPIC,
    });
    const sctx = resolveSessionContext(ctx as never);
    expect(sctx).toBeDefined();
    expect(sctx!.source).toBe("cc");
    expect(sctx!.sessionId).toBe(CC_ID);
    expect(sctx!.sessionDir).toBe(CC_CWD);
    expect(sctx!.topicId).toBe(CC_TOPIC);
    expect(sctx!.chatId).toBe(CHAT_ID);
    expect(sctx!.sessionName).toBe(CC_NAME);
  });

  test("Cursor topic returns a Cursor context", () => {
    const ctx = makeContext({
      chatId: CHAT_ID,
      userId: 1,
      threadId: CURSOR_TOPIC,
    });
    const sctx = resolveSessionContext(ctx as never);
    expect(sctx).toBeDefined();
    expect(sctx!.source).toBe("cursor");
    expect(sctx!.sessionId).toBe(CURSOR_NAME);
    expect(sctx!.sessionName).toBe(CURSOR_NAME);
  });

  test("private chat returns undefined", () => {
    const ctx = makeContext({
      chatId: 999,
      userId: 1,
      chatType: "private",
    });
    expect(resolveSessionContext(ctx as never)).toBeUndefined();
  });

  test("General topic (thread_id=1) returns undefined", () => {
    const ctx = makeContext({
      chatId: CHAT_ID,
      userId: 1,
      threadId: 1,
    });
    expect(resolveSessionContext(ctx as never)).toBeUndefined();
  });

  test("unknown topic returns undefined", () => {
    const ctx = makeContext({
      chatId: CHAT_ID,
      userId: 1,
      threadId: 99999,
    });
    expect(resolveSessionContext(ctx as never)).toBeUndefined();
  });

  test("resolution is independent of recently-active sessions", () => {
    // Same condition as S1 in Phase 0: Cursor bumped to "most recent", but
    // CC topic still resolves to CC.
    addCursorSession({ name: "cursor-other", dir: "/tmp/__other__" });

    const ctx = makeContext({
      chatId: CHAT_ID,
      userId: 1,
      threadId: CC_TOPIC,
    });
    const sctx = resolveSessionContext(ctx as never);
    expect(sctx!.source).toBe("cc");
    expect(sctx!.sessionId).toBe(CC_ID);

    removeSession("cursor-other");
  });
});
