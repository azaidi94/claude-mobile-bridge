/**
 * Unit tests for file download / send-file feature.
 *
 * Tests sendFileToTelegram, file directive extraction/stripping,
 * path validation, size limits, and photo vs document routing.
 */

import { describe, expect, test, beforeEach, mock } from "bun:test";
import { writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { DESKTOP_SPAWN_CONFIG_MOCK } from "./config-mock-desktop";

// Mock config before importing handlers
mock.module("../config", () => ({
  ALLOWED_USERS: [123456],
  TELEGRAM_TOKEN: "test-token",
  WORKING_DIR: "/tmp/test-working-dir",
  OPENAI_API_KEY: "",
  CLAUDE_CLI_PATH: "/usr/local/bin/claude",
  ...DESKTOP_SPAWN_CONFIG_MOCK,
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
  BOT_DIR: "/tmp/test-bot-dir",
  TEMP_DIR: "/tmp/telegram-bot",
  TEMP_PATHS: ["/tmp/", "/private/tmp/", "/var/folders/"],
  RELAY_PORT_FILE_PREFIX: "/tmp/channel-relay-",
  RELAY_CONNECT_TIMEOUT_MS: 3000,
  RELAY_RESPONSE_TIMEOUT_MS: 300000,
}));

// Mock security module directly to avoid cross-test mock contamination
import { resolve, normalize } from "path";
import { realpathSync } from "fs";

const MOCK_ALLOWED_PATHS = ["/tmp"];
const MOCK_TEMP_PATHS = ["/tmp/", "/private/tmp/", "/var/folders/"];

mock.module("../security", () => ({
  isPathAllowed: (path: string) => {
    try {
      const expanded = path.replace(/^~/, process.env.HOME || "");
      const normalized = normalize(expanded);
      let resolved: string;
      try {
        resolved = realpathSync(normalized);
      } catch {
        resolved = resolve(normalized);
      }
      for (const tempPath of MOCK_TEMP_PATHS) {
        if (resolved.startsWith(tempPath)) return true;
      }
      for (const allowed of MOCK_ALLOWED_PATHS) {
        const allowedResolved = resolve(allowed);
        if (
          resolved === allowedResolved ||
          resolved.startsWith(allowedResolved + "/")
        )
          return true;
      }
      return false;
    } catch {
      return false;
    }
  },
  rateLimiter: {
    check: () => [true],
    getStatus: () => ({ tokens: 20, max: 20, refillRate: 0.33 }),
  },
  checkCommandSafety: () => [true, ""],
  isAuthorized: (userId: number, allowed: number[]) => allowed.includes(userId),
}));

const TEST_DIR = "/tmp/test-file-download";

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

// ============== sendFileToTelegram Tests ==============

describe("file-download: sendFileToTelegram", () => {
  function createMockContext() {
    const replies: Array<{ text: string }> = [];
    const photos: Array<{ caption?: string }> = [];
    const documents: Array<{ caption?: string }> = [];

    return {
      reply: mock(async (text: string) => {
        replies.push({ text });
        return { chat: { id: 123 }, message_id: replies.length };
      }),
      replyWithPhoto: mock(
        async (_file: unknown, opts?: { caption?: string }) => {
          photos.push({ caption: opts?.caption });
          return { chat: { id: 123 }, message_id: 1 };
        },
      ),
      replyWithDocument: mock(
        async (_file: unknown, opts?: { caption?: string }) => {
          documents.push({ caption: opts?.caption });
          return { chat: { id: 123 }, message_id: 1 };
        },
      ),
      _replies: replies,
      _photos: photos,
      _documents: documents,
    };
  }

  test("sends .jpg as photo", async () => {
    const { sendFileToTelegram } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const filePath = join(TEST_DIR, "test.jpg");
    await writeFile(filePath, "fake-jpeg-data");

    await sendFileToTelegram(ctx as any, filePath);

    expect(ctx._photos.length).toBe(1);
    expect(ctx._photos[0]?.caption).toBe("test.jpg");
    expect(ctx._documents.length).toBe(0);

    await unlink(filePath);
  });

  test("sends .png as photo", async () => {
    const { sendFileToTelegram } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const filePath = join(TEST_DIR, "test.png");
    await writeFile(filePath, "fake-png-data");

    await sendFileToTelegram(ctx as any, filePath);

    expect(ctx._photos.length).toBe(1);
    expect(ctx._documents.length).toBe(0);

    await unlink(filePath);
  });

  test("sends .webp as photo", async () => {
    const { sendFileToTelegram } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const filePath = join(TEST_DIR, "test.webp");
    await writeFile(filePath, "fake-webp-data");

    await sendFileToTelegram(ctx as any, filePath);

    expect(ctx._photos.length).toBe(1);

    await unlink(filePath);
  });

  test("sends .gif as document (not photo)", async () => {
    const { sendFileToTelegram } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const filePath = join(TEST_DIR, "anim.gif");
    await writeFile(filePath, "fake-gif-data");

    await sendFileToTelegram(ctx as any, filePath);

    expect(ctx._documents.length).toBe(1);
    expect(ctx._documents[0]?.caption).toBe("anim.gif");
    expect(ctx._photos.length).toBe(0);

    await unlink(filePath);
  });

  test("sends .bmp as document (not photo)", async () => {
    const { sendFileToTelegram } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const filePath = join(TEST_DIR, "image.bmp");
    await writeFile(filePath, "fake-bmp-data");

    await sendFileToTelegram(ctx as any, filePath);

    expect(ctx._documents.length).toBe(1);
    expect(ctx._photos.length).toBe(0);

    await unlink(filePath);
  });

  test("sends .md as document", async () => {
    const { sendFileToTelegram } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const filePath = join(TEST_DIR, "report.md");
    await writeFile(filePath, "# Security Audit\n\nAll good.");

    await sendFileToTelegram(ctx as any, filePath);

    expect(ctx._documents.length).toBe(1);
    expect(ctx._documents[0]?.caption).toBe("report.md");
    expect(ctx._photos.length).toBe(0);

    await unlink(filePath);
  });

  test("sends .pdf as document", async () => {
    const { sendFileToTelegram } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const filePath = join(TEST_DIR, "doc.pdf");
    await writeFile(filePath, "fake-pdf-data");

    await sendFileToTelegram(ctx as any, filePath);

    expect(ctx._documents.length).toBe(1);

    await unlink(filePath);
  });

  test("blocks paths outside allowed directories", async () => {
    const { sendFileToTelegram } = await import("../handlers/streaming");
    const ctx = createMockContext();

    await sendFileToTelegram(ctx as any, "/etc/passwd");

    expect(ctx._replies.length).toBe(1);
    expect(ctx._replies[0]?.text).toContain("Cannot send file");
    expect(ctx._photos.length).toBe(0);
    expect(ctx._documents.length).toBe(0);
  });

  test("handles non-existent file gracefully", async () => {
    const { sendFileToTelegram } = await import("../handlers/streaming");
    const ctx = createMockContext();

    await sendFileToTelegram(ctx as any, join(TEST_DIR, "does-not-exist.txt"));

    expect(ctx._replies.length).toBe(1);
    expect(ctx._replies[0]?.text).toContain("Could not read file");
  });

  test("handles empty file", async () => {
    const { sendFileToTelegram } = await import("../handlers/streaming");
    const ctx = createMockContext();
    const filePath = join(TEST_DIR, "empty.txt");
    await writeFile(filePath, "");

    await sendFileToTelegram(ctx as any, filePath);

    expect(ctx._replies.length).toBe(1);
    expect(ctx._replies[0]?.text).toContain("File is empty");

    await unlink(filePath);
  });

  test("falls back to document when photo send fails", async () => {
    const { sendFileToTelegram } = await import("../handlers/streaming");
    const ctx = createMockContext();

    // Make replyWithPhoto fail
    ctx.replyWithPhoto = mock(async () => {
      throw new Error("Photo too large");
    }) as any;

    const filePath = join(TEST_DIR, "big.jpg");
    await writeFile(filePath, "fake-big-jpeg");

    await sendFileToTelegram(ctx as any, filePath);

    // Should fall back to document
    expect(ctx._documents.length).toBe(1);

    await unlink(filePath);
  });

  test("resolves path traversal before checking", async () => {
    const { sendFileToTelegram } = await import("../handlers/streaming");
    const ctx = createMockContext();

    // Try path traversal that resolves outside allowed paths
    await sendFileToTelegram(ctx as any, "/tmp/../etc/passwd");

    expect(ctx._replies.length).toBe(1);
    expect(ctx._replies[0]?.text).toContain("Cannot send file");
  });

  test("does not leak error details to user", async () => {
    const { sendFileToTelegram } = await import("../handlers/streaming");
    const ctx = createMockContext();

    await sendFileToTelegram(ctx as any, join(TEST_DIR, "missing.txt"));

    // Error message should be user-friendly, not raw error
    const msg = ctx._replies[0]?.text || "";
    expect(msg).not.toContain("ENOENT");
    expect(msg).not.toContain("Error:");
    expect(msg).toContain("Could not read file");
  });
});

// ============== File Directive Extraction Tests ==============

describe("file-download: directive extraction", () => {
  // We test the helpers indirectly via session.ts behavior,
  // but we can also test the regex patterns directly.

  test("single directive is extracted", () => {
    const text = "Here is the file:\n<<SEND_FILE:/tmp/report.md>>\nEnjoy!";
    const matches = [...text.matchAll(/<<SEND_FILE:(.+?)>>/g)];
    expect(matches.length).toBe(1);
    expect(matches[0]![1]).toBe("/tmp/report.md");
  });

  test("multiple directives are extracted", () => {
    const text =
      "<<SEND_FILE:/tmp/a.md>>\n<<SEND_FILE:/tmp/b.png>>\n<<SEND_FILE:/tmp/c.pdf>>";
    const matches = [...text.matchAll(/<<SEND_FILE:(.+?)>>/g)];
    expect(matches.length).toBe(3);
    expect(matches[0]![1]).toBe("/tmp/a.md");
    expect(matches[1]![1]).toBe("/tmp/b.png");
    expect(matches[2]![1]).toBe("/tmp/c.pdf");
  });

  test("directive with spaces in path is extracted", () => {
    const text = "<<SEND_FILE:/tmp/my folder/report file.md>>";
    const matches = [...text.matchAll(/<<SEND_FILE:(.+?)>>/g)];
    expect(matches.length).toBe(1);
    expect(matches[0]![1]).toBe("/tmp/my folder/report file.md");
  });

  test("directive embedded in text is extracted", () => {
    const text =
      "I created the report. <<SEND_FILE:/tmp/audit.md>> Let me know if you need anything.";
    const matches = [...text.matchAll(/<<SEND_FILE:(.+?)>>/g)];
    expect(matches.length).toBe(1);
    expect(matches[0]![1]).toBe("/tmp/audit.md");
  });

  test("text without directives yields no matches", () => {
    const text = "No files to send here.";
    const matches = [...text.matchAll(/<<SEND_FILE:(.+?)>>/g)];
    expect(matches.length).toBe(0);
  });
});

// ============== Directive Stripping Tests ==============

describe("file-download: directive stripping", () => {
  const strip = (text: string) => text.replace(/<<SEND_FILE:.+?>>\n?/g, "");

  test("strips single directive", () => {
    const text = "Here is the file:\n<<SEND_FILE:/tmp/report.md>>\nEnjoy!";
    expect(strip(text)).toBe("Here is the file:\nEnjoy!");
  });

  test("strips multiple directives", () => {
    const text =
      "Files:\n<<SEND_FILE:/tmp/a.md>>\n<<SEND_FILE:/tmp/b.png>>\nDone.";
    expect(strip(text)).toBe("Files:\nDone.");
  });

  test("strips directive with trailing newline", () => {
    const text = "<<SEND_FILE:/tmp/file.txt>>\nSome text after.";
    expect(strip(text)).toBe("Some text after.");
  });

  test("strips directive without trailing newline", () => {
    const text = "Before <<SEND_FILE:/tmp/file.txt>> after";
    expect(strip(text)).toBe("Before  after");
  });

  test("returns original text when no directives", () => {
    const text = "No directives here.";
    expect(strip(text)).toBe("No directives here.");
  });
});

// ============== Deduplication Tests ==============

describe("file-download: deduplication", () => {
  test("Set removes duplicate paths", () => {
    const files = [
      "/tmp/a.md",
      "/tmp/b.md",
      "/tmp/a.md",
      "/tmp/c.md",
      "/tmp/b.md",
    ];
    const unique = [...new Set(files)];
    expect(unique).toEqual(["/tmp/a.md", "/tmp/b.md", "/tmp/c.md"]);
  });

  test("Set preserves order of first occurrence", () => {
    const files = ["/tmp/c.md", "/tmp/a.md", "/tmp/c.md"];
    const unique = [...new Set(files)];
    expect(unique).toEqual(["/tmp/c.md", "/tmp/a.md"]);
  });
});

// ============== Status Callback send_file Tests ==============

describe("file-download: createStatusCallback send_file", () => {
  function createMockContext() {
    const replies: Array<{ text: string }> = [];
    const documents: Array<{ caption?: string }> = [];

    return {
      reply: mock(async (text: string) => {
        replies.push({ text });
        return { chat: { id: 123 }, message_id: replies.length };
      }),
      replyWithPhoto: mock(async () => {
        return { chat: { id: 123 }, message_id: 1 };
      }),
      replyWithDocument: mock(
        async (_file: unknown, opts?: { caption?: string }) => {
          documents.push({ caption: opts?.caption });
          return { chat: { id: 123 }, message_id: 1 };
        },
      ),
      api: {
        editMessageText: mock(async () => ({})),
        deleteMessage: mock(async () => true),
      },
      _replies: replies,
      _documents: documents,
    };
  }

  test("send_file callback sends valid file", async () => {
    const { createStatusCallback, StreamingState } =
      await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();
    const callback = createStatusCallback(ctx as any, state);

    const filePath = join(TEST_DIR, "callback-test.txt");
    await writeFile(filePath, "test content");

    await callback("send_file", filePath);

    expect(ctx._documents.length).toBe(1);
    expect(ctx._documents[0]?.caption).toBe("callback-test.txt");

    await unlink(filePath);
  });

  test("send_file callback handles errors without leaking details", async () => {
    const { createStatusCallback, StreamingState } =
      await import("../handlers/streaming");
    const ctx = createMockContext();
    const state = new StreamingState();

    // Make all file operations fail
    ctx.replyWithDocument = mock(async () => {
      throw new Error("Internal network error with sensitive details");
    }) as any;

    const callback = createStatusCallback(ctx as any, state);
    const filePath = join(TEST_DIR, "fail-test.txt");
    await writeFile(filePath, "content");

    await callback("send_file", filePath);

    // Should get a generic error, not the raw internal error
    const errorReply = ctx._replies.find((r) => r.text.includes("Failed"));
    expect(errorReply?.text).toBe("⚠️ Failed to send file.");
    expect(errorReply?.text).not.toContain("Internal network");

    await unlink(filePath);
  });
});
