/**
 * Unit tests for src/topics/topic-router.ts.
 */

// Bootstrap env — must run before any import that touches config.ts.
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "test-token";
process.env.TELEGRAM_ALLOWED_USERS =
  process.env.TELEGRAM_ALLOWED_USERS || "12345";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Context } from "grammy";

import {
  isGeneralTopic,
  isSessionTopic,
  getThreadId,
  getThreadIdFromCallback,
} from "../topics/topic-router";
import { addTopicMapping, clearTopicStore } from "../topics/topic-store";
import { _reloadForTests, saveSetting } from "../settings";

let tmpDir: string;
let settingsPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "topic-router-test-"));
  settingsPath = join(tmpDir, "settings.json");
  process.env.CLAUDE_MOBILE_BRIDGE_SETTINGS_FILE = settingsPath;
  process.env.CLAUDE_TELEGRAM_TOPICS_FILE = join(tmpDir, "topics.json");
  _reloadForTests();
  clearTopicStore();
});

afterEach(async () => {
  clearTopicStore();
  _reloadForTests();
  delete process.env.CLAUDE_MOBILE_BRIDGE_SETTINGS_FILE;
  delete process.env.CLAUDE_TELEGRAM_TOPICS_FILE;
  await rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(threadId?: number): Context {
  return {
    message: threadId !== undefined ? { message_thread_id: threadId } : {},
  } as unknown as Context;
}

function makeCallbackCtx(threadId?: number): Context {
  if (threadId === undefined) {
    return { callbackQuery: {} } as unknown as Context;
  }
  return {
    callbackQuery: {
      message: { message_thread_id: threadId },
    },
  } as unknown as Context;
}

function makeMapping(sessionName: string, topicId: number) {
  return {
    topicId,
    sessionName,
    sessionDir: "/tmp/test",
    isOnline: true,
    createdAt: new Date().toISOString(),
  };
}

describe("isGeneralTopic", () => {
  test("returns true for undefined thread_id", () => {
    const ctx = makeCtx();
    expect(isGeneralTopic(ctx)).toBe(true);
  });

  test("returns true for thread_id=1", () => {
    const ctx = makeCtx(1);
    expect(isGeneralTopic(ctx)).toBe(true);
  });

  test("returns false for other thread_ids", () => {
    const ctx = makeCtx(42);
    expect(isGeneralTopic(ctx)).toBe(false);
  });
});

describe("isSessionTopic", () => {
  test("returns null for General (no thread_id)", () => {
    expect(isSessionTopic(makeCtx())).toBeNull();
  });

  test("returns null for General (thread_id=1)", () => {
    expect(isSessionTopic(makeCtx(1))).toBeNull();
  });

  test("returns null for unknown topic", () => {
    expect(isSessionTopic(makeCtx(999))).toBeNull();
  });

  test("returns session info when topic found in store", () => {
    addTopicMapping(makeMapping("my-session", 42));
    const result = isSessionTopic(makeCtx(42));
    expect(result).not.toBeNull();
    expect(result!.sessionName).toBe("my-session");
    expect(result!.topicId).toBe(42);
    expect(result!.mapping.sessionDir).toBe("/tmp/test");
  });
});

describe("getThreadId", () => {
  test("returns topicId when mapping exists and topics enabled", () => {
    // topics enabled by default
    addTopicMapping(makeMapping("sess", 77));
    expect(getThreadId("sess")).toBe(77);
  });

  test("returns undefined for unknown session", () => {
    expect(getThreadId("nope")).toBeUndefined();
  });
});

describe("getThreadIdFromCallback", () => {
  test("returns undefined when no callback message", () => {
    const ctx = { callbackQuery: {} } as unknown as Context;
    expect(getThreadIdFromCallback(ctx)).toBeUndefined();
  });

  test("returns undefined when no callbackQuery at all", () => {
    const ctx = {} as unknown as Context;
    expect(getThreadIdFromCallback(ctx)).toBeUndefined();
  });

  test("returns thread_id from callback message", () => {
    const ctx = makeCallbackCtx(55);
    expect(getThreadIdFromCallback(ctx)).toBe(55);
  });
});
