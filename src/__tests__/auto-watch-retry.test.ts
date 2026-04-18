/**
 * Tests for the _awaitSessionId retry helper used by startAutoWatch.
 *
 * Race fixed: when a brand-new Claude session spawns, the relay port file
 * appears before the JSONL file has a parseable first line, so the bot's
 * initial scan returns SessionInfo with id="". startAutoWatch used to give
 * up with "missing session id" and never retry. The helper now polls
 * forceRefresh()/getSession() with backoff until the id resolves.
 */

import "./ensure-test-env";
import { describe, expect, test, mock, beforeEach } from "bun:test";
import type { SessionInfo } from "../sessions/types";

let getSessionImpl: (name: string) => SessionInfo | null = () => null;
let forceRefreshCalls = 0;

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
