/**
 * Unit tests for status message (pinned message) functionality.
 *
 * Note: Integration tests for updatePinnedStatus are skipped in the full suite
 * due to bun:test mock module caching issues. The core logic is tested via
 * formatStatusMessage and the get/set/clear helpers which work reliably.
 */

import { describe, expect, test } from "bun:test";

// Import directly from source file to avoid barrel export issues with mocking
import {
  formatStatusMessage,
  getPinnedMessageId,
  setPinnedMessageId,
  clearPinnedMessageId,
  type StatusInfo,
} from "../sessions/status-message";

describe("status-message: formatStatusMessage", () => {
  test("formats normal mode correctly", () => {
    const status: StatusInfo = {
      sessionName: "my-project",
      isPlanMode: false,
      model: "Opus 4.5",
    };

    const result = formatStatusMessage(status);
    expect(result).toBe("✅ my-project | ⚡ Normal | Opus 4.5");
  });

  test("formats plan mode correctly", () => {
    const status: StatusInfo = {
      sessionName: "my-project",
      isPlanMode: true,
      model: "Opus 4.5",
    };

    const result = formatStatusMessage(status);
    expect(result).toBe("✅ my-project | 📋 Plan | Opus 4.5");
  });

  test("handles null session name", () => {
    const status: StatusInfo = {
      sessionName: null,
      isPlanMode: false,
      model: "Sonnet 4.5",
    };

    const result = formatStatusMessage(status);
    expect(result).toBe("✅ no session | ⚡ Normal | Sonnet 4.5");
  });

  test("handles different models", () => {
    const status: StatusInfo = {
      sessionName: "test",
      isPlanMode: false,
      model: "Haiku 4.5",
    };

    const result = formatStatusMessage(status);
    expect(result).toContain("Haiku 4.5");
  });

  test("mode change from normal to plan produces different text", () => {
    const normalStatus = formatStatusMessage({
      sessionName: "test",
      isPlanMode: false,
      model: "Opus 4.5",
    });

    const planStatus = formatStatusMessage({
      sessionName: "test",
      isPlanMode: true,
      model: "Opus 4.5",
    });

    expect(normalStatus).toContain("⚡ Normal");
    expect(planStatus).toContain("📋 Plan");
    expect(normalStatus).not.toBe(planStatus);
  });
});

describe("status-message: pinned message ID management", () => {
  test("stores and retrieves message ID by chat", () => {
    const testChatId = Math.floor(Math.random() * 1000000000);
    clearPinnedMessageId(testChatId);

    expect(getPinnedMessageId(testChatId)).toBeUndefined();

    setPinnedMessageId(testChatId, 555);
    expect(getPinnedMessageId(testChatId)).toBe(555);

    clearPinnedMessageId(testChatId);
    expect(getPinnedMessageId(testChatId)).toBeUndefined();
  });

  test("handles multiple chats independently", () => {
    const chat1 = Math.floor(Math.random() * 1000000000);
    const chat2 = Math.floor(Math.random() * 1000000000) + 1;

    clearPinnedMessageId(chat1);
    clearPinnedMessageId(chat2);

    setPinnedMessageId(chat1, 111);
    setPinnedMessageId(chat2, 222);

    expect(getPinnedMessageId(chat1)).toBe(111);
    expect(getPinnedMessageId(chat2)).toBe(222);

    clearPinnedMessageId(chat1);
    clearPinnedMessageId(chat2);
  });

  test("overwrites existing message ID", () => {
    const chatId = Math.floor(Math.random() * 1000000000);
    clearPinnedMessageId(chatId);

    setPinnedMessageId(chatId, 100);
    expect(getPinnedMessageId(chatId)).toBe(100);

    setPinnedMessageId(chatId, 200);
    expect(getPinnedMessageId(chatId)).toBe(200);

    clearPinnedMessageId(chatId);
  });
});
