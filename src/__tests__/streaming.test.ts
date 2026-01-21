/**
 * Unit tests for streaming response functionality.
 *
 * Tests StreamingState, createStatusCallback, createAskUserKeyboard,
 * checkPendingAskUserRequests, message edit rate limiting, and error handling.
 */

import { describe, expect, test, beforeEach, mock, spyOn } from "bun:test";
import { unlink, writeFile } from "fs/promises";

// Mock config before importing handlers - must include all exports to avoid conflicts
mock.module("../config", () => ({
  ALLOWED_USERS: [123456],
  TELEGRAM_TOKEN: "test-token",
  WORKING_DIR: "/tmp/test-working-dir",
  OPENAI_API_KEY: "",
  CLAUDE_CLI_PATH: "/usr/local/bin/claude",
  MCP_SERVERS: {},
  ALLOWED_PATHS: ["/tmp"],
  SAFETY_PROMPT: "test prompt",
  BLOCKED_PATTERNS: ["rm -rf /"],
  QUERY_TIMEOUT_MS: 180000,
  TRANSCRIPTION_PROMPT: "test",
  TRANSCRIPTION_AVAILABLE: false,
  THINKING_KEYWORDS: ["think"],
  THINKING_DEEP_KEYWORDS: ["ultrathink"],
  MEDIA_GROUP_TIMEOUT: 1000,
  TELEGRAM_MESSAGE_LIMIT: 4096,
  TELEGRAM_SAFE_LIMIT: 4000,
  STREAMING_THROTTLE_MS: 500,
  BUTTON_LABEL_MAX_LENGTH: 30,
  AUDIT_LOG_PATH: "/tmp/audit.log",
  AUDIT_LOG_JSON: false,
  RATE_LIMIT_ENABLED: false,
  RATE_LIMIT_REQUESTS: 20,
  RATE_LIMIT_WINDOW: 60,
  SESSION_FILE: "/tmp/test-session.json",
  RESTART_FILE: "/tmp/test-restart.json",
  TEMP_DIR: "/tmp/telegram-bot",
  TEMP_PATHS: ["/tmp/"],
}));

// ============== StreamingState Tests ==============

describe("streaming: StreamingState", () => {
  test("initializes with empty maps and arrays", async () => {
    const { StreamingState } = await import("../handlers/streaming");
    const state = new StreamingState();

    expect(state.textMessages.size).toBe(0);
    expect(state.toolMessages.length).toBe(0);
    expect(state.lastEditTimes.size).toBe(0);
    expect(state.lastContent.size).toBe(0);
  });

  test("tracks text messages by segment ID", async () => {
    const { StreamingState } = await import("../handlers/streaming");
    const state = new StreamingState();

    const mockMsg = { chat: { id: 123 }, message_id: 456 } as any;
    state.textMessages.set(0, mockMsg);
    state.textMessages.set(1, { chat: { id: 123 }, message_id: 789 } as any);

    expect(state.textMessages.size).toBe(2);
    expect(state.textMessages.get(0)?.message_id).toBe(456);
    expect(state.textMessages.get(1)?.message_id).toBe(789);
  });

  test("tracks tool messages in array", async () => {
    const { StreamingState } = await import("../handlers/streaming");
    const state = new StreamingState();

    state.toolMessages.push({ chat: { id: 1 }, message_id: 100 } as any);
    state.toolMessages.push({ chat: { id: 1 }, message_id: 101 } as any);

    expect(state.toolMessages.length).toBe(2);
    expect(state.toolMessages[0]?.message_id).toBe(100);
    expect(state.toolMessages[1]?.message_id).toBe(101);
  });

  test("tracks last edit times by segment ID", async () => {
    const { StreamingState } = await import("../handlers/streaming");
    const state = new StreamingState();

    const now = Date.now();
    state.lastEditTimes.set(0, now - 1000);
    state.lastEditTimes.set(1, now);

    expect(state.lastEditTimes.size).toBe(2);
    expect(state.lastEditTimes.get(0)).toBe(now - 1000);
    expect(state.lastEditTimes.get(1)).toBe(now);
  });

  test("tracks last content by segment ID", async () => {
    const { StreamingState } = await import("../handlers/streaming");
    const state = new StreamingState();

    state.lastContent.set(0, "Hello world");
    state.lastContent.set(1, "Another message");

    expect(state.lastContent.size).toBe(2);
    expect(state.lastContent.get(0)).toBe("Hello world");
    expect(state.lastContent.get(1)).toBe("Another message");
  });
});

// ============== createAskUserKeyboard Tests ==============

describe("streaming: createAskUserKeyboard", () => {
  test("creates keyboard with options as rows", async () => {
    const { createAskUserKeyboard } = await import("../handlers/streaming");

    const keyboard = createAskUserKeyboard("req-123", ["Option 1", "Option 2"]);

    // InlineKeyboard has inline_keyboard property
    // Note: grammy adds an empty row at the end after each .row() call
    const data = (keyboard as any).inline_keyboard;
    expect(data).toBeDefined();
    // 2 options + 1 trailing empty row from .row() calls
    expect(data.length).toBe(3);
    // But the first two rows should have the buttons
    expect(data[0][0].text).toBe("Option 1");
    expect(data[1][0].text).toBe("Option 2");
  });

  test("creates callback data with requestId and index", async () => {
    const { createAskUserKeyboard } = await import("../handlers/streaming");

    const keyboard = createAskUserKeyboard("abc-def", ["First", "Second"]);

    const data = (keyboard as any).inline_keyboard;
    // Each row contains button with callback_data
    expect(data[0][0].callback_data).toBe("askuser:abc-def:0");
    expect(data[1][0].callback_data).toBe("askuser:abc-def:1");
  });

  test("truncates long option labels", async () => {
    const { createAskUserKeyboard } = await import("../handlers/streaming");

    const longOption = "A".repeat(50); // Longer than BUTTON_LABEL_MAX_LENGTH (30)
    const keyboard = createAskUserKeyboard("req-1", [longOption]);

    const data = (keyboard as any).inline_keyboard;
    const buttonText = data[0][0].text;
    expect(buttonText.length).toBeLessThanOrEqual(33); // 30 + "..."
    expect(buttonText.endsWith("...")).toBe(true);
  });

  test("preserves short option labels", async () => {
    const { createAskUserKeyboard } = await import("../handlers/streaming");

    const shortOption = "Short";
    const keyboard = createAskUserKeyboard("req-1", [shortOption]);

    const data = (keyboard as any).inline_keyboard;
    expect(data[0][0].text).toBe("Short");
  });

  test("handles empty options array", async () => {
    const { createAskUserKeyboard } = await import("../handlers/streaming");

    const keyboard = createAskUserKeyboard("req-1", []);

    const data = (keyboard as any).inline_keyboard;
    // Empty options creates empty keyboard
    expect(data.length).toBeLessThanOrEqual(1);
  });

  test("handles many options", async () => {
    const { createAskUserKeyboard } = await import("../handlers/streaming");

    const options = ["A", "B", "C", "D", "E"];
    const keyboard = createAskUserKeyboard("req-1", options);

    const data = (keyboard as any).inline_keyboard;
    // 5 options + trailing empty row
    expect(data.length).toBe(6);
    // Verify all 5 buttons are present
    expect(data[0][0].text).toBe("A");
    expect(data[4][0].text).toBe("E");
  });
});

// ============== createStatusCallback Tests ==============

describe("streaming: createStatusCallback", () => {
  function createMockContext() {
    const replies: Array<{ text: string; options?: Record<string, unknown> }> = [];
    const edits: Array<{ chatId: number; msgId: number; text: string; options?: Record<string, unknown> }> = [];
    const deletes: Array<{ chatId: number; msgId: number }> = [];

    return {
      reply: mock(async (text: string, options?: Record<string, unknown>) => {
        replies.push({ text, options });
        return { chat: { id: 123 }, message_id: replies.length };
      }),
      api: {
        editMessageText: mock(async (chatId: number, msgId: number, text: string, options?: Record<string, unknown>) => {
          edits.push({ chatId, msgId, text, options });
          return {};
        }),
        deleteMessage: mock(async (chatId: number, msgId: number) => {
          deletes.push({ chatId, msgId });
          return true;
        }),
      },
      _replies: replies,
      _edits: edits,
      _deletes: deletes,
    };
  }

  test("handles 'thinking' status type", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    await callback("thinking", "Analyzing the problem...");

    expect(ctx._replies.length).toBe(1);
    expect(ctx._replies[0]?.text).toContain("Analyzing the problem");
    expect(ctx._replies[0]?.options?.parse_mode).toBe("HTML");
    expect(state.toolMessages.length).toBe(1);
  });

  test("thinking status truncates long content", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    const longThinking = "X".repeat(600);
    await callback("thinking", longThinking);

    expect(ctx._replies[0]?.text).toContain("...");
    expect(ctx._replies[0]?.text.length).toBeLessThan(600);
  });

  test("handles 'tool' status type", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    await callback("tool", "📖 Reading <code>file.ts</code>");

    expect(ctx._replies.length).toBe(1);
    expect(ctx._replies[0]?.text).toContain("Reading");
    expect(ctx._replies[0]?.options?.parse_mode).toBe("HTML");
    expect(state.toolMessages.length).toBe(1);
  });

  test("handles 'text' status type for new segment", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    await callback("text", "Hello world!", 0);

    expect(ctx._replies.length).toBe(1);
    expect(ctx._replies[0]?.text).toContain("Hello world");
    expect(state.textMessages.size).toBe(1);
    expect(state.textMessages.has(0)).toBe(true);
  });

  test("text status without segmentId is ignored", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    await callback("text", "Hello world!");

    expect(ctx._replies.length).toBe(0);
    expect(state.textMessages.size).toBe(0);
  });

  test("text status throttles rapid updates", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    // First call creates message
    await callback("text", "First content", 0);
    expect(ctx._replies.length).toBe(1);

    // Rapid second call should not edit (throttled)
    await callback("text", "Updated content", 0);
    expect(ctx._edits.length).toBe(0);
  });

  test("text status edits after throttle period", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    // First call creates message
    await callback("text", "First content", 0);

    // Manually set lastEditTime to past to bypass throttle
    state.lastEditTimes.set(0, Date.now() - 1000);
    state.lastContent.set(0, "different content");

    await callback("text", "New content here", 0);
    expect(ctx._edits.length).toBe(1);
  });

  test("text status skips edit when content unchanged", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const { convertMarkdownToHtml } = await import("../formatting");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    // First call creates message
    await callback("text", "Same content", 0);
    const formatted = convertMarkdownToHtml("Same content");

    // Bypass throttle and set same content
    state.lastEditTimes.set(0, Date.now() - 1000);
    state.lastContent.set(0, formatted);

    await callback("text", "Same content", 0);
    expect(ctx._edits.length).toBe(0);
  });

  test("text status truncates content exceeding safe limit", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    const longContent = "X".repeat(5000); // Exceeds TELEGRAM_SAFE_LIMIT (4000)
    await callback("text", longContent, 0);

    expect(ctx._replies[0]?.text).toContain("...");
    expect(ctx._replies[0]?.text.length).toBeLessThanOrEqual(4003); // 4000 + "..."
  });

  test("handles 'segment_end' status type", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    // First create a text message
    await callback("text", "Initial", 0);

    // Then end the segment with final content
    state.lastContent.set(0, "different");
    await callback("segment_end", "Final content", 0);

    expect(ctx._edits.length).toBe(1);
    expect(ctx._edits[0]?.text).toContain("Final content");
  });

  test("segment_end without existing message is no-op", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    await callback("segment_end", "Content", 0);

    expect(ctx._edits.length).toBe(0);
    expect(ctx._replies.length).toBe(0);
  });

  test("segment_end without segmentId is no-op", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    await callback("segment_end", "Content");

    expect(ctx._edits.length).toBe(0);
  });

  test("segment_end skips when content unchanged", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const { convertMarkdownToHtml } = await import("../formatting");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    await callback("text", "Same", 0);
    const formatted = convertMarkdownToHtml("Same");
    state.lastContent.set(0, formatted);

    await callback("segment_end", "Same", 0);

    expect(ctx._edits.length).toBe(0);
  });

  test("segment_end splits long messages", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    // Create initial message
    await callback("text", "Short", 0);
    state.lastContent.set(0, "different");

    // End with very long content
    const longContent = "X".repeat(5000);
    await callback("segment_end", longContent, 0);

    // Should delete original and send chunks
    expect(ctx._deletes.length).toBe(1);
    expect(ctx._replies.length).toBeGreaterThan(1); // Initial + chunks
  });

  test("handles 'done' status type - deletes tool messages", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    // Create some tool messages first
    await callback("tool", "Tool 1");
    await callback("tool", "Tool 2");
    expect(state.toolMessages.length).toBe(2);

    // Done should delete tool messages
    await callback("done", "");

    expect(ctx._deletes.length).toBe(2);
  });

  test("done preserves text messages", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    // Create text and tool messages
    await callback("text", "Text content", 0);
    await callback("tool", "Tool status");

    const textMsgId = state.textMessages.get(0)?.message_id;

    await callback("done", "");

    // Only tool message should be deleted
    expect(ctx._deletes.length).toBe(1);
    // Text message ID should not be in deletes
    const deletedIds = ctx._deletes.map(d => d.msgId);
    expect(deletedIds).not.toContain(textMsgId);
  });

  test("handles multiple segments independently", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    await callback("text", "Segment 0", 0);
    await callback("text", "Segment 1", 1);
    await callback("text", "Segment 2", 2);

    expect(ctx._replies.length).toBe(3);
    expect(state.textMessages.size).toBe(3);
    expect(state.textMessages.has(0)).toBe(true);
    expect(state.textMessages.has(1)).toBe(true);
    expect(state.textMessages.has(2)).toBe(true);
  });

  test("callback handles errors gracefully", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();

    // Make reply throw
    ctx.reply = mock(async () => {
      throw new Error("Network error");
    });

    const callback = createStatusCallback(ctx as any, state);

    // Should not throw
    await callback("text", "Content", 0);

    // Message should not be tracked since reply failed
    expect(state.textMessages.size).toBe(0);
  });

  test("edit failure falls back to plain text", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    // Create initial message
    await callback("text", "Initial", 0);
    state.lastEditTimes.set(0, Date.now() - 1000);
    state.lastContent.set(0, "different");

    // Make first edit throw (HTML parse error), second succeed
    let callCount = 0;
    ctx.api.editMessageText = mock(async () => {
      callCount++;
      if (callCount === 1) throw new Error("HTML parse error");
      return {};
    });

    await callback("text", "Updated", 0);

    // Should have tried twice (HTML then plain)
    expect(callCount).toBe(2);
  });
});

// ============== checkPendingAskUserRequests Tests ==============

describe("streaming: checkPendingAskUserRequests", () => {
  const testFile = "/tmp/ask-user-test-123.json";

  beforeEach(async () => {
    // Clean up test file
    try {
      await unlink(testFile);
    } catch {
      // File doesn't exist, that's fine
    }
  });

  function createMockContext(chatId: number) {
    const replies: Array<{ text: string; options?: Record<string, unknown> }> = [];
    return {
      reply: mock(async (text: string, options?: Record<string, unknown>) => {
        replies.push({ text, options });
        return { chat: { id: chatId }, message_id: Date.now() };
      }),
      _replies: replies,
    };
  }

  test("returns false when no ask-user files exist", async () => {
    const { checkPendingAskUserRequests } = await import("../handlers/streaming");
    const ctx = createMockContext(123);

    const result = await checkPendingAskUserRequests(ctx as any, 123);

    expect(result).toBe(false);
    expect(ctx._replies.length).toBe(0);
  });

  test("processes pending request for matching chat", async () => {
    const { checkPendingAskUserRequests } = await import("../handlers/streaming");

    // Create ask-user file
    const data = {
      status: "pending",
      chat_id: 456,
      question: "Choose an option:",
      options: ["Option A", "Option B"],
      request_id: "test-req-1",
    };
    await writeFile(testFile, JSON.stringify(data));

    const ctx = createMockContext(456);
    const result = await checkPendingAskUserRequests(ctx as any, 456);

    expect(result).toBe(true);
    expect(ctx._replies.length).toBe(1);
    expect(ctx._replies[0]?.text).toContain("Choose an option");

    // Clean up
    await unlink(testFile);
  });

  test("ignores requests for different chat", async () => {
    const { checkPendingAskUserRequests } = await import("../handlers/streaming");

    // Create ask-user file for different chat
    const data = {
      status: "pending",
      chat_id: 999,
      question: "Other chat question",
      options: ["A", "B"],
      request_id: "test-req-2",
    };
    await writeFile(testFile, JSON.stringify(data));

    const ctx = createMockContext(123);
    const result = await checkPendingAskUserRequests(ctx as any, 123);

    expect(result).toBe(false);
    expect(ctx._replies.length).toBe(0);

    // Clean up
    await unlink(testFile);
  });

  test("ignores non-pending status", async () => {
    const { checkPendingAskUserRequests } = await import("../handlers/streaming");

    // Create already-sent request
    const data = {
      status: "sent",
      chat_id: 123,
      question: "Already sent",
      options: ["A"],
      request_id: "test-req-3",
    };
    await writeFile(testFile, JSON.stringify(data));

    const ctx = createMockContext(123);
    const result = await checkPendingAskUserRequests(ctx as any, 123);

    expect(result).toBe(false);

    // Clean up
    await unlink(testFile);
  });

  test("marks request as sent after processing", async () => {
    const { checkPendingAskUserRequests } = await import("../handlers/streaming");

    const data = {
      status: "pending",
      chat_id: 789,
      question: "Test question",
      options: ["Yes", "No"],
      request_id: "test-req-4",
    };
    await writeFile(testFile, JSON.stringify(data));

    const ctx = createMockContext(789);
    await checkPendingAskUserRequests(ctx as any, 789);

    // Read file and check status
    const updatedContent = await Bun.file(testFile).text();
    const updated = JSON.parse(updatedContent);
    expect(updated.status).toBe("sent");

    // Clean up
    await unlink(testFile);
  });

  test("includes keyboard with options", async () => {
    const { checkPendingAskUserRequests } = await import("../handlers/streaming");

    const data = {
      status: "pending",
      chat_id: 111,
      question: "Pick one",
      options: ["First", "Second", "Third"],
      request_id: "test-req-5",
    };
    await writeFile(testFile, JSON.stringify(data));

    const ctx = createMockContext(111);
    await checkPendingAskUserRequests(ctx as any, 111);

    const keyboard = ctx._replies[0]?.options?.reply_markup as any;
    expect(keyboard).toBeDefined();
    // 3 options + trailing empty row
    expect(keyboard.inline_keyboard.length).toBe(4);
    // Verify the 3 buttons are present
    expect(keyboard.inline_keyboard[0][0].text).toBe("First");
    expect(keyboard.inline_keyboard[2][0].text).toBe("Third");

    // Clean up
    await unlink(testFile);
  });

  test("ignores request without options", async () => {
    const { checkPendingAskUserRequests } = await import("../handlers/streaming");

    const data = {
      status: "pending",
      chat_id: 222,
      question: "No options question",
      options: [],
      request_id: "test-req-6",
    };
    await writeFile(testFile, JSON.stringify(data));

    const ctx = createMockContext(222);
    const result = await checkPendingAskUserRequests(ctx as any, 222);

    expect(result).toBe(false);

    // Clean up
    await unlink(testFile);
  });

  test("ignores request without request_id", async () => {
    const { checkPendingAskUserRequests } = await import("../handlers/streaming");

    const data = {
      status: "pending",
      chat_id: 333,
      question: "No ID question",
      options: ["A"],
      // missing request_id
    };
    await writeFile(testFile, JSON.stringify(data));

    const ctx = createMockContext(333);
    const result = await checkPendingAskUserRequests(ctx as any, 333);

    expect(result).toBe(false);

    // Clean up
    await unlink(testFile);
  });

  test("handles malformed JSON gracefully", async () => {
    const { checkPendingAskUserRequests } = await import("../handlers/streaming");

    await writeFile(testFile, "not valid json {{{");

    const ctx = createMockContext(123);

    // Should not throw
    const result = await checkPendingAskUserRequests(ctx as any, 123);

    expect(result).toBe(false);

    // Clean up
    await unlink(testFile);
  });

  test("handles chat_id as string", async () => {
    const { checkPendingAskUserRequests } = await import("../handlers/streaming");

    // chat_id as string (some JSON might serialize this way)
    const data = {
      status: "pending",
      chat_id: "444",
      question: "String chat ID",
      options: ["OK"],
      request_id: "test-req-7",
    };
    await writeFile(testFile, JSON.stringify(data));

    const ctx = createMockContext(444);
    const result = await checkPendingAskUserRequests(ctx as any, 444);

    expect(result).toBe(true);

    // Clean up
    await unlink(testFile);
  });

  test("uses default question when not provided", async () => {
    const { checkPendingAskUserRequests } = await import("../handlers/streaming");

    const data = {
      status: "pending",
      chat_id: 555,
      // no question field
      options: ["A", "B"],
      request_id: "test-req-8",
    };
    await writeFile(testFile, JSON.stringify(data));

    const ctx = createMockContext(555);
    await checkPendingAskUserRequests(ctx as any, 555);

    expect(ctx._replies[0]?.text).toContain("Please choose");

    // Clean up
    await unlink(testFile);
  });
});

// ============== Rate Limiting / Throttling Tests ==============

describe("streaming: rate limiting", () => {
  function createMockContext() {
    const replies: Array<{ text: string }> = [];
    const edits: Array<{ text: string }> = [];

    return {
      reply: mock(async (text: string) => {
        replies.push({ text });
        return { chat: { id: 123 }, message_id: replies.length };
      }),
      api: {
        editMessageText: mock(async (_chatId: number, _msgId: number, text: string) => {
          edits.push({ text });
          return {};
        }),
        deleteMessage: mock(async () => true),
      },
      _replies: replies,
      _edits: edits,
    };
  }

  test("first text update creates new message immediately", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    await callback("text", "First message content", 0);

    expect(ctx._replies.length).toBe(1);
    expect(state.lastEditTimes.has(0)).toBe(true);
  });

  test("rapid updates within throttle window are skipped", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    await callback("text", "Content 1", 0);

    // These should be throttled (within 500ms window)
    await callback("text", "Content 2", 0);
    await callback("text", "Content 3", 0);
    await callback("text", "Content 4", 0);

    expect(ctx._replies.length).toBe(1); // Only initial
    expect(ctx._edits.length).toBe(0); // No edits due to throttle
  });

  test("update after throttle period goes through", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    await callback("text", "Initial", 0);

    // Simulate time passing by modifying lastEditTime
    state.lastEditTimes.set(0, Date.now() - 600); // 600ms ago (> 500ms throttle)
    state.lastContent.set(0, "different");

    await callback("text", "After throttle", 0);

    expect(ctx._edits.length).toBe(1);
  });

  test("different segments have independent throttling", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    // Create segment 0
    await callback("text", "Segment 0", 0);

    // Create segment 1 (should work - different segment)
    await callback("text", "Segment 1", 1);

    expect(ctx._replies.length).toBe(2);

    // Update segment 0 should be throttled
    await callback("text", "Updated 0", 0);

    // But creating segment 2 works
    await callback("text", "Segment 2", 2);

    expect(ctx._replies.length).toBe(3);
    expect(ctx._edits.length).toBe(0); // segment 0 update was throttled
  });
});

// ============== Error Recovery Tests ==============

describe("streaming: error recovery", () => {
  test("reply failure doesn't prevent future messages", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");

    let callCount = 0;
    const ctx = {
      reply: mock(async () => {
        callCount++;
        // Both calls fail - simulating network down
        if (callCount <= 2) throw new Error("Network error");
        return { chat: { id: 123 }, message_id: callCount };
      }),
      api: {
        editMessageText: mock(async () => ({})),
        deleteMessage: mock(async () => true),
      },
    };

    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    // First segment - both HTML and fallback fail, so no message tracked
    await callback("text", "First", 0);
    expect(state.textMessages.has(0)).toBe(false);

    // Second segment - now reply works
    await callback("text", "Second", 1);
    expect(state.textMessages.has(1)).toBe(true);
  });

  test("delete failure during done is handled", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");

    const ctx = {
      reply: mock(async () => ({ chat: { id: 123 }, message_id: 1 })),
      api: {
        editMessageText: mock(async () => ({})),
        deleteMessage: mock(async () => {
          throw new Error("Delete failed");
        }),
      },
    };

    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    await callback("tool", "Tool status");

    // Should not throw
    await callback("done", "");
  });

  test("HTML formatting failure falls back gracefully", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");

    let htmlAttempts = 0;
    const replies: string[] = [];

    const ctx = {
      reply: mock(async (text: string, options?: any) => {
        replies.push(text);
        if (options?.parse_mode === "HTML") {
          htmlAttempts++;
          throw new Error("HTML parse error");
        }
        return { chat: { id: 123 }, message_id: 1 };
      }),
      api: {
        editMessageText: mock(async () => ({})),
        deleteMessage: mock(async () => true),
      },
    };

    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    await callback("text", "Test content", 0);

    // Should have tried HTML first, then fallen back
    expect(htmlAttempts).toBe(1);
    expect(replies.length).toBe(2); // HTML attempt + fallback
  });
});

// ============== Message Content Tracking Tests ==============

describe("streaming: content tracking", () => {
  function createMockContext() {
    return {
      reply: mock(async () => ({ chat: { id: 123 }, message_id: 1 })),
      api: {
        editMessageText: mock(async () => ({})),
        deleteMessage: mock(async () => true),
      },
    };
  }

  test("lastContent is set on new message creation", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    await callback("text", "Hello world", 0);

    expect(state.lastContent.has(0)).toBe(true);
    expect(state.lastContent.get(0)).toContain("Hello world");
  });

  test("lastContent is updated on successful edit", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    await callback("text", "Initial", 0);

    // Force update by bypassing throttle
    state.lastEditTimes.set(0, Date.now() - 1000);
    state.lastContent.set(0, "old content");

    await callback("text", "Updated content here", 0);

    expect(state.lastContent.get(0)).toContain("Updated content");
  });

  test("lastEditTimes is updated after each successful operation", async () => {
    const { createStatusCallback, StreamingState } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    const before = Date.now();
    await callback("text", "Content", 0);
    const after = Date.now();

    const editTime = state.lastEditTimes.get(0);
    expect(editTime).toBeDefined();
    expect(editTime).toBeGreaterThanOrEqual(before);
    expect(editTime).toBeLessThanOrEqual(after);
  });
});
