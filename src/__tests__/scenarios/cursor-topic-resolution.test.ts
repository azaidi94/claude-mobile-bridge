/**
 * S3 — Cursor topics expose a `cursor-` synthetic sessionId in sessionOverride.
 *
 * Locks down the contract that lets photo/voice/document handlers reject
 * cleanly in Cursor topics (the guards we added 2026-05-25). Phase 5 will
 * eventually fold this into the `Session.capabilities` model — but until
 * then, the synthetic-id-prefix check IS the contract.
 */

import {
  setupIsolatedStateDir,
  teardownStateDir,
  makeContext,
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
const { loadTopicSession } = await import("../../topics");
const { setChatId, addTopicMapping, removeTopicMapping } =
  await import("../../topics/topic-store");
const { addCursorSession, removeSession } = await import("../../sessions");

const CHAT_ID = -1009999999999;
const CURSOR_TOPIC = 99;
const CURSOR_NAME = "cursor-phase0-s3";

beforeEach(() => {
  setChatId(CHAT_ID);
  addCursorSession({ name: CURSOR_NAME, dir: "/Users/test" });
  addTopicMapping({
    topicId: CURSOR_TOPIC,
    sessionName: CURSOR_NAME,
    sessionDir: "/Users/test",
    sessionId: CURSOR_NAME, // Cursor uses the synthetic name as id
    isOnline: true,
    createdAt: new Date().toISOString(),
  });
});

afterEach(() => {
  removeTopicMapping(CURSOR_NAME);
  removeSession(CURSOR_NAME);
});

afterAll(() => {
  teardownStateDir(STATE_DIR);
});

describe("S3 — Cursor topic resolution", () => {
  test("loadTopicSession returns a cursor- synthetic id for a Cursor topic", () => {
    const ctx = makeContext({
      chatId: CHAT_ID,
      userId: 1,
      threadId: CURSOR_TOPIC,
    });
    const result = loadTopicSession(ctx as never);
    expect(result).toBeDefined();
    expect(result!.sessionOverride).toBeDefined();
    expect(result!.sessionOverride!.sessionId.startsWith("cursor-")).toBe(true);
  });

  test("the cursor- prefix is the contract the photo/voice/document guards check", () => {
    // This test exists purely to document the contract that the production
    // handlers (and src/handlers/relay-bridge.ts's sendViaRelay early-return)
    // rely on. If a future refactor changes how Cursor session ids are
    // formed without updating the guards, *this* test catches it.
    const ctx = makeContext({
      chatId: CHAT_ID,
      userId: 1,
      threadId: CURSOR_TOPIC,
    });
    const sid = loadTopicSession(ctx as never)!.sessionOverride!.sessionId;
    expect(sid.startsWith("cursor-")).toBe(true);
  });
});
