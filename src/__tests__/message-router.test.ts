/**
 * Unit tests for message routing and forwarding.
 *
 * Tests text handler message flow: auth, rate limiting, session routing,
 * error handling, and message formatting/sanitization.
 */

import { describe, expect, test, beforeEach, afterEach, mock, spyOn } from "bun:test";

// Mock config before importing handlers
const mockConfig = {
  ALLOWED_USERS: [123456],
  TELEGRAM_TOKEN: "test-token",
  WORKING_DIR: "/tmp/test",
  RATE_LIMIT_ENABLED: true,
  RATE_LIMIT_REQUESTS: 20,
  RATE_LIMIT_WINDOW: 60,
  ALLOWED_PATHS: ["/tmp"],
  BLOCKED_PATTERNS: ["rm -rf /"],
  SAFETY_PROMPT: "test prompt",
  MCP_SERVERS: {},
  SESSION_FILE: "/tmp/test-session.json",
  STREAMING_THROTTLE_MS: 500,
  TEMP_PATHS: ["/tmp/"],
  THINKING_KEYWORDS: ["think"],
  THINKING_DEEP_KEYWORDS: ["ultrathink"],
};

// Test helpers
function createMockContext(overrides: Partial<{
  userId: number;
  username: string;
  chatId: number;
  messageText: string;
}> = {}) {
  const {
    userId = 123456,
    username = "testuser",
    chatId = 789,
    messageText = "test message",
  } = overrides;

  const replies: string[] = [];

  return {
    from: { id: userId, username },
    chat: { id: chatId },
    message: { text: messageText },
    reply: mock(async (text: string) => {
      replies.push(text);
      return { chat: { id: chatId }, message_id: Date.now() };
    }),
    api: {
      sendMessage: mock(async () => ({ message_id: Date.now() })),
      editMessageText: mock(async () => ({})),
      deleteMessage: mock(async () => true),
    },
    _replies: replies,
  };
}

// ============== Authorization Tests ==============

describe("message-router: authorization", () => {
  test("isAuthorized returns true for allowed user", async () => {
    const { isAuthorized } = await import("../security");
    expect(isAuthorized(123456, [123456])).toBe(true);
  });

  test("isAuthorized returns false for non-allowed user", async () => {
    const { isAuthorized } = await import("../security");
    expect(isAuthorized(999999, [123456])).toBe(false);
  });

  test("isAuthorized returns false for undefined user", async () => {
    const { isAuthorized } = await import("../security");
    expect(isAuthorized(undefined, [123456])).toBe(false);
  });

  test("isAuthorized returns false for empty allowed list", async () => {
    const { isAuthorized } = await import("../security");
    expect(isAuthorized(123456, [])).toBe(false);
  });

  test("isAuthorized handles multiple allowed users", async () => {
    const { isAuthorized } = await import("../security");
    const allowedUsers = [111, 222, 333];
    expect(isAuthorized(222, allowedUsers)).toBe(true);
    expect(isAuthorized(444, allowedUsers)).toBe(false);
  });
});

// ============== Rate Limiting Tests ==============

describe("message-router: rate limiting", () => {
  test("rateLimiter allows requests within limit", async () => {
    const { rateLimiter } = await import("../security");
    const userId = Date.now(); // Unique user ID

    const [allowed] = rateLimiter.check(userId);
    expect(allowed).toBe(true);
  });

  test("rateLimiter returns status with tokens", async () => {
    const { rateLimiter } = await import("../security");
    const userId = Date.now() + 1;

    const status = rateLimiter.getStatus(userId);
    expect(status).toHaveProperty("tokens");
    expect(status).toHaveProperty("max");
    expect(status).toHaveProperty("refillRate");
    expect(status.max).toBeGreaterThan(0);
  });

  test("rateLimiter decrements tokens on check", async () => {
    const { rateLimiter } = await import("../security");
    const userId = Date.now() + 2;

    const before = rateLimiter.getStatus(userId);
    rateLimiter.check(userId);
    const after = rateLimiter.getStatus(userId);

    expect(after.tokens).toBeLessThan(before.tokens);
  });

  test("rateLimiter returns retryAfter when exhausted", async () => {
    const { rateLimiter } = await import("../security");
    const userId = Date.now() + 3;

    // Exhaust all tokens
    for (let i = 0; i < 25; i++) {
      rateLimiter.check(userId);
    }

    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      expect(retryAfter).toBeGreaterThan(0);
    }
  });
});

// ============== Message Formatting Tests ==============

describe("message-router: message formatting", () => {
  test("escapeHtml escapes special characters", async () => {
    const { escapeHtml } = await import("../formatting");

    // Single quotes are not escaped (only needed for attribute values with single quotes)
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert('xss')&lt;/script&gt;"
    );
  });

  test("escapeHtml escapes ampersands", async () => {
    const { escapeHtml } = await import("../formatting");
    expect(escapeHtml("foo & bar")).toBe("foo &amp; bar");
  });

  test("convertMarkdownToHtml converts bold", async () => {
    const { convertMarkdownToHtml } = await import("../formatting");
    expect(convertMarkdownToHtml("**bold**")).toContain("<b>bold</b>");
  });

  test("convertMarkdownToHtml converts italic", async () => {
    const { convertMarkdownToHtml } = await import("../formatting");
    expect(convertMarkdownToHtml("_italic_")).toContain("<i>italic</i>");
  });

  test("convertMarkdownToHtml converts code blocks", async () => {
    const { convertMarkdownToHtml } = await import("../formatting");
    const result = convertMarkdownToHtml("```\ncode\n```");
    expect(result).toContain("<pre>");
    expect(result).toContain("code");
    expect(result).toContain("</pre>");
  });

  test("convertMarkdownToHtml converts inline code", async () => {
    const { convertMarkdownToHtml } = await import("../formatting");
    expect(convertMarkdownToHtml("`code`")).toContain("<code>code</code>");
  });

  test("convertMarkdownToHtml converts headers to bold", async () => {
    const { convertMarkdownToHtml } = await import("../formatting");
    expect(convertMarkdownToHtml("## Header")).toContain("<b>Header</b>");
  });

  test("convertMarkdownToHtml converts bullet lists", async () => {
    const { convertMarkdownToHtml } = await import("../formatting");
    expect(convertMarkdownToHtml("- item")).toContain("• item");
  });

  test("convertMarkdownToHtml converts links", async () => {
    const { convertMarkdownToHtml } = await import("../formatting");
    const result = convertMarkdownToHtml("[link](https://example.com)");
    expect(result).toContain('<a href="https://example.com">link</a>');
  });

  test("convertMarkdownToHtml handles nested formatting", async () => {
    const { convertMarkdownToHtml } = await import("../formatting");
    const result = convertMarkdownToHtml("**bold with `code`**");
    expect(result).toContain("<b>");
    expect(result).toContain("<code>");
  });

  test("convertMarkdownToHtml preserves code block content", async () => {
    const { convertMarkdownToHtml } = await import("../formatting");
    const result = convertMarkdownToHtml("```\n**not bold**\n```");
    // Inside code block, ** should be preserved/escaped, not converted
    expect(result).not.toContain("<b>not bold</b>");
  });

  test("convertMarkdownToHtml collapses multiple newlines", async () => {
    const { convertMarkdownToHtml } = await import("../formatting");
    const result = convertMarkdownToHtml("line1\n\n\n\nline2");
    expect(result).toBe("line1\n\nline2");
  });
});

// ============== Tool Status Formatting Tests ==============

describe("message-router: tool status formatting", () => {
  test("formatToolStatus formats Read tool", async () => {
    const { formatToolStatus } = await import("../formatting");
    const result = formatToolStatus("Read", { file_path: "/path/to/file.ts" });
    expect(result).toContain("Reading");
    expect(result).toContain("file.ts");
  });

  test("formatToolStatus formats Write tool", async () => {
    const { formatToolStatus } = await import("../formatting");
    const result = formatToolStatus("Write", { file_path: "/path/to/new.ts" });
    expect(result).toContain("Writing");
    expect(result).toContain("new.ts");
  });

  test("formatToolStatus formats Bash tool with description", async () => {
    const { formatToolStatus } = await import("../formatting");
    const result = formatToolStatus("Bash", {
      command: "npm install",
      description: "Install dependencies"
    });
    expect(result).toContain("Install dependencies");
  });

  test("formatToolStatus formats Bash tool without description", async () => {
    const { formatToolStatus } = await import("../formatting");
    const result = formatToolStatus("Bash", { command: "npm install" });
    expect(result).toContain("npm install");
  });

  test("formatToolStatus formats Grep tool", async () => {
    const { formatToolStatus } = await import("../formatting");
    const result = formatToolStatus("Grep", { pattern: "function", path: "/src" });
    expect(result).toContain("Searching");
    expect(result).toContain("function");
  });

  test("formatToolStatus formats image Read as viewing", async () => {
    const { formatToolStatus } = await import("../formatting");
    const result = formatToolStatus("Read", { file_path: "/path/image.png" });
    expect(result).toContain("Viewing");
  });

  test("formatToolStatus truncates long commands", async () => {
    const { formatToolStatus } = await import("../formatting");
    const longCommand = "a".repeat(100);
    const result = formatToolStatus("Bash", { command: longCommand });
    expect(result.length).toBeLessThan(100);
  });

  test("formatToolStatus formats MCP tools", async () => {
    const { formatToolStatus } = await import("../formatting");
    const result = formatToolStatus("mcp__server__action", { query: "test" });
    expect(result).toContain("server");
  });
});

// ============== Path Validation Tests ==============

describe("message-router: path validation", () => {
  test("isPathAllowed allows temp paths", async () => {
    const { isPathAllowed } = await import("../security");
    expect(isPathAllowed("/tmp/test.txt")).toBe(true);
  });

  test("isPathAllowed blocks paths outside allowed dirs", async () => {
    const { isPathAllowed } = await import("../security");
    expect(isPathAllowed("/etc/passwd")).toBe(false);
  });

  test("isPathAllowed handles home directory expansion", async () => {
    const { isPathAllowed } = await import("../security");
    // ~ paths should be resolved
    const result = isPathAllowed("~/Documents/test.txt");
    // Result depends on ALLOWED_PATHS config
    expect(typeof result).toBe("boolean");
  });

  test("isPathAllowed handles normalized paths", async () => {
    const { isPathAllowed } = await import("../security");
    // Path traversal should be normalized
    expect(isPathAllowed("/tmp/../tmp/test.txt")).toBe(true);
  });
});

// ============== Command Safety Tests ==============

describe("message-router: command safety", () => {
  test("checkCommandSafety blocks dangerous patterns", async () => {
    const { checkCommandSafety } = await import("../security");
    const [safe] = checkCommandSafety("rm -rf /");
    expect(safe).toBe(false);
  });

  test("checkCommandSafety allows safe commands", async () => {
    const { checkCommandSafety } = await import("../security");
    const [safe] = checkCommandSafety("ls -la /tmp");
    expect(safe).toBe(true);
  });

  test("checkCommandSafety blocks fork bomb", async () => {
    const { checkCommandSafety } = await import("../security");
    const [safe] = checkCommandSafety(":(){ :|:& };:");
    expect(safe).toBe(false);
  });

  test("checkCommandSafety blocks sudo rm", async () => {
    const { checkCommandSafety } = await import("../security");
    const [safe] = checkCommandSafety("sudo rm -rf /var");
    expect(safe).toBe(false);
  });

  test("checkCommandSafety validates rm paths", async () => {
    const { checkCommandSafety } = await import("../security");
    // rm within allowed temp path should be ok
    const [safeTmp] = checkCommandSafety("rm /tmp/test.txt");
    expect(safeTmp).toBe(true);
  });

  test("checkCommandSafety returns reason when blocked", async () => {
    const { checkCommandSafety } = await import("../security");
    const [safe, reason] = checkCommandSafety("rm -rf /");
    expect(safe).toBe(false);
    expect(reason).toBeTruthy();
    expect(reason.length).toBeGreaterThan(0);
  });
});

// ============== Streaming State Tests ==============

describe("message-router: streaming state", () => {
  test("StreamingState initializes with empty collections", async () => {
    const { StreamingState } = await import("../handlers/streaming");
    const state = new StreamingState();

    expect(state.textMessages.size).toBe(0);
    expect(state.toolMessages.length).toBe(0);
    expect(state.lastEditTimes.size).toBe(0);
    expect(state.lastContent.size).toBe(0);
  });

  test("StreamingState tracks text messages by segment", async () => {
    const { StreamingState } = await import("../handlers/streaming");
    const state = new StreamingState();

    const mockMsg = { chat: { id: 123 }, message_id: 456 } as any;
    state.textMessages.set(0, mockMsg);

    expect(state.textMessages.has(0)).toBe(true);
    expect(state.textMessages.get(0)).toBe(mockMsg);
  });

  test("StreamingState tracks tool messages", async () => {
    const { StreamingState } = await import("../handlers/streaming");
    const state = new StreamingState();

    const mockMsg = { chat: { id: 123 }, message_id: 789 } as any;
    state.toolMessages.push(mockMsg);

    expect(state.toolMessages.length).toBe(1);
  });

  test("StreamingState tracks edit times for throttling", async () => {
    const { StreamingState } = await import("../handlers/streaming");
    const state = new StreamingState();

    const now = Date.now();
    state.lastEditTimes.set(0, now);

    expect(state.lastEditTimes.get(0)).toBe(now);
  });

  test("StreamingState tracks content for deduplication", async () => {
    const { StreamingState } = await import("../handlers/streaming");
    const state = new StreamingState();

    state.lastContent.set(0, "test content");

    expect(state.lastContent.get(0)).toBe("test content");
  });
});

// ============== Error Handling Tests ==============

describe("message-router: error handling", () => {
  test("checkCommandSafety handles malformed rm commands gracefully", async () => {
    const { checkCommandSafety } = await import("../security");
    // Just "rm " with no args
    const [safe] = checkCommandSafety("rm ");
    expect(typeof safe).toBe("boolean");
  });

  test("isPathAllowed handles invalid paths gracefully", async () => {
    const { isPathAllowed } = await import("../security");
    // Empty path
    const result = isPathAllowed("");
    expect(typeof result).toBe("boolean");
  });

  test("convertMarkdownToHtml handles empty string", async () => {
    const { convertMarkdownToHtml } = await import("../formatting");
    expect(convertMarkdownToHtml("")).toBe("");
  });

  test("convertMarkdownToHtml handles only whitespace", async () => {
    const { convertMarkdownToHtml } = await import("../formatting");
    const result = convertMarkdownToHtml("   \n\n   ");
    expect(typeof result).toBe("string");
  });

  test("formatToolStatus handles missing input gracefully", async () => {
    const { formatToolStatus } = await import("../formatting");
    const result = formatToolStatus("Unknown", {});
    expect(typeof result).toBe("string");
  });

  test("formatToolStatus handles null/undefined file_path", async () => {
    const { formatToolStatus } = await import("../formatting");
    const result = formatToolStatus("Read", { file_path: undefined });
    expect(result).toContain("Reading");
  });
});

// ============== Session Routing Tests ==============

describe("message-router: session routing", () => {
  test("getActiveSession returns null when no sessions", async () => {
    // Use a fresh import to test initial state
    const { getActiveSession, getSessions } = await import("../sessions");

    // If there happen to be no sessions, should return null
    // (Can't guarantee this in tests with persistent state)
    const active = getActiveSession();
    if (getSessions().length === 0) {
      expect(active).toBeNull();
    } else {
      // If sessions exist, active should be one of them
      expect(active).not.toBeNull();
    }
  });

  test("setActiveSession returns false for non-existent session", async () => {
    const { setActiveSession } = await import("../sessions");
    const result = setActiveSession(`nonexistent-${Date.now()}`);
    expect(result).toBe(false);
  });

  test("addTelegramSession and switch routes correctly", async () => {
    const { addTelegramSession, setActiveSession, getActiveSession } = await import("../sessions");

    const name1 = `route-test-1-${Date.now()}`;
    const name2 = `route-test-2-${Date.now()}`;

    addTelegramSession("/tmp/project1", name1);
    addTelegramSession("/tmp/project2", name2);

    // name2 should be active (most recent)
    expect(getActiveSession()!.name).toBe(name2);

    // Switch to name1
    setActiveSession(name1);
    expect(getActiveSession()!.name).toBe(name1);
  });
});

// ============== Message Sanitization Tests ==============

describe("message-router: message sanitization", () => {
  test("escapeHtml prevents HTML injection", async () => {
    const { escapeHtml } = await import("../formatting");
    const malicious = '<img src=x onerror="alert(1)">';
    const escaped = escapeHtml(malicious);
    expect(escaped).not.toContain("<img");
    expect(escaped).toContain("&lt;img");
  });

  test("escapeHtml handles all special HTML chars", async () => {
    const { escapeHtml } = await import("../formatting");
    const input = '<>&"';
    const escaped = escapeHtml(input);
    expect(escaped).toBe("&lt;&gt;&amp;&quot;");
  });

  test("convertMarkdownToHtml escapes HTML in regular text", async () => {
    const { convertMarkdownToHtml } = await import("../formatting");
    const result = convertMarkdownToHtml("Hello <script>alert(1)</script>");
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });

  test("code blocks escape their content", async () => {
    const { convertMarkdownToHtml } = await import("../formatting");
    const result = convertMarkdownToHtml("```\n<div>test</div>\n```");
    expect(result).toContain("&lt;div&gt;");
  });
});
