/**
 * Unit tests for conversation history parsing and formatting.
 */

import { describe, expect, test } from "bun:test";

import {
  formatHistoryMessage,
  getRecentHistory,
  type ConversationPair,
} from "../sessions/history";

// ============== formatHistoryMessage ==============

describe("history: formatHistoryMessage", () => {
  test("returns empty for no pairs", () => {
    expect(formatHistoryMessage([])).toBe("");
  });

  test("formats single pair", () => {
    const pairs: ConversationPair[] = [
      { user: "hello", assistant: "hi there" },
    ];
    const result = formatHistoryMessage(pairs);
    expect(result).toContain("👤 hello");
    expect(result).toContain("🤖 hi there");
    expect(result).toContain("<blockquote expandable>");
    expect(result).toContain("💬 <b>Recent</b>");
  });

  test("formats pair with no assistant response", () => {
    const pairs: ConversationPair[] = [{ user: "hello", assistant: null }];
    const result = formatHistoryMessage(pairs);
    expect(result).toContain("👤 hello");
    expect(result).not.toContain("🤖");
  });

  test("escapes HTML in messages", () => {
    const pairs: ConversationPair[] = [
      { user: "use <b>bold</b> & stuff", assistant: "here's a <script>" },
    ];
    const result = formatHistoryMessage(pairs);
    expect(result).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(result).toContain("&amp; stuff");
    expect(result).toContain("&lt;script&gt;");
  });

  test("truncates long user messages at 150 chars", () => {
    const longMsg = "a".repeat(200);
    const pairs: ConversationPair[] = [{ user: longMsg, assistant: "short" }];
    const result = formatHistoryMessage(pairs);
    expect(result).toContain("a".repeat(150) + "...");
  });

  test("last assistant gets more space (400 chars)", () => {
    const longAssistant = "b".repeat(300);
    const pairs: ConversationPair[] = [
      { user: "q1", assistant: longAssistant },
    ];
    const result = formatHistoryMessage(pairs);
    // Should NOT be truncated at 80
    expect(result).toContain("b".repeat(300));
  });

  test("non-last assistant truncated at 80 chars", () => {
    const longAssistant = "b".repeat(200);
    const pairs: ConversationPair[] = [
      { user: "q1", assistant: longAssistant },
      { user: "q2", assistant: "short" },
    ];
    const result = formatHistoryMessage(pairs);
    // First assistant should be truncated
    expect(result).toContain("b".repeat(80) + "...");
  });

  test("result never exceeds 4000 chars", () => {
    // Generate enough pairs to overflow the limit
    const pairs: ConversationPair[] = Array.from({ length: 20 }, (_, i) => ({
      user: `question ${i} ${"x".repeat(150)}`,
      assistant: `answer ${i} ${"y".repeat(400)}`,
    }));
    const result = formatHistoryMessage(pairs);
    expect(result.length).toBeLessThanOrEqual(4000);
    // Should still contain some content
    expect(result).toContain("👤");
    expect(result).toContain("🤖");
  });

  test("multiple pairs formatted with spacing", () => {
    const pairs: ConversationPair[] = [
      { user: "first", assistant: "reply1" },
      { user: "second", assistant: "reply2" },
      { user: "third", assistant: "reply3" },
    ];
    const result = formatHistoryMessage(pairs);
    expect(result).toContain("👤 first");
    expect(result).toContain("👤 second");
    expect(result).toContain("👤 third");
    expect(result).toContain("🤖 reply1");
    expect(result).toContain("🤖 reply3");
  });
});

// ============== getRecentHistory ==============

describe("history: getRecentHistory", () => {
  test("returns empty for empty sessionId", async () => {
    expect(await getRecentHistory("")).toEqual([]);
  });

  test("returns empty for non-existent session", async () => {
    expect(await getRecentHistory("nonexistent-id")).toEqual([]);
  });
});

// ============== Parsing logic (tested via formatHistoryMessage + integration) ==============

describe("history: conversation pairing logic", () => {
  // We can't easily test getRecentHistory with real files due to PROJECTS_DIR,
  // but we CAN test the formatting pipeline end-to-end by verifying
  // formatHistoryMessage handles various pair patterns correctly.

  test("user without assistant shows solo", () => {
    const pairs: ConversationPair[] = [
      { user: "first", assistant: null },
      { user: "second", assistant: "got it" },
    ];
    const result = formatHistoryMessage(pairs);
    expect(result).toContain("👤 first");
    expect(result).toContain("👤 second");
    expect(result).toContain("🤖 got it");
  });

  test("handles all pairs having assistant responses", () => {
    const pairs: ConversationPair[] = [
      { user: "q1", assistant: "a1" },
      { user: "q2", assistant: "a2" },
    ];
    const result = formatHistoryMessage(pairs);
    const userMatches = result.match(/👤/g);
    const botMatches = result.match(/🤖/g);
    expect(userMatches?.length).toBe(2);
    expect(botMatches?.length).toBe(2);
  });

  test("returns empty string for empty input", () => {
    expect(formatHistoryMessage([])).toBe("");
  });
});
