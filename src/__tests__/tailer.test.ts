/**
 * Unit tests for SessionTailer (sessions/tailer.ts).
 *
 * Tests JSONL line parsing, event emission, and session file discovery.
 */

import "./ensure-test-env";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// Import directly from source to avoid barrel export issues
import {
  SessionTailer,
  findSessionJsonlPath,
  getExpectedJsonlPath,
  type TailEvent,
} from "../sessions/tailer";

// ============== parseLine ==============

describe("tailer: parseLine", () => {
  let tailer: SessionTailer;

  beforeEach(() => {
    tailer = new SessionTailer("/dev/null", () => {});
  });

  test("parses assistant text block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello world" }],
      },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("text");
    expect(events[0]!.content).toBe("Hello world");
    expect(events[1]!.type).toBe("turn_end");
  });

  test("parses assistant tool_use block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: "/home/user/project/src/index.ts" },
          },
        ],
      },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("tool");
    expect(events[0]!.content).toContain("Reading");
  });

  test("parses assistant thinking block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "Let me think about this..." }],
      },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("thinking");
    expect(events[0]!.content).toBe("Let me think about this...");
    expect(events[1]!.type).toBe("turn_end");
  });

  test("truncates long thinking content", () => {
    const longThinking = "x".repeat(300);
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: longThinking }],
      },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(2);
    expect(events[0]!.content.length).toBeLessThan(250);
    expect(events[0]!.content).toEndWith("...");
    expect(events[1]!.type).toBe("turn_end");
  });

  test("emits ALL blocks from a single entry (thinking + tool_use)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "Planning..." },
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "ls", description: "List files" },
          },
        ],
      },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("thinking");
    expect(events[1]!.type).toBe("tool");
  });

  test("emits ALL blocks from a single entry (tool_use + text)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Grep",
            input: { pattern: "TODO" },
          },
          { type: "text", text: "Found 3 matches." },
        ],
      },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("tool");
    expect(events[1]!.type).toBe("text");
  });

  test("parses user text message (string content)", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: "Fix the bug" },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("user");
    expect(events[0]!.content).toBe("Fix the bug");
  });

  test("parses user text message (array content)", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "text", text: "Fix the bug" }],
      },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("user");
    expect(events[0]!.content).toBe("Fix the bug");
  });

  test("emits tool_result event for user tool_result-only messages", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "abc", content: "ok" }],
      },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "abc",
      content: "ok",
    });
  });

  test("skips sidechain messages", () => {
    const line = JSON.stringify({
      type: "assistant",
      isSidechain: true,
      message: {
        content: [{ type: "text", text: "sidechain text" }],
      },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(0);
  });

  test("handles malformed JSON gracefully", () => {
    const events = tailer.parseLine("not valid json {{{");
    expect(events).toHaveLength(0);
  });

  test("handles empty line", () => {
    const events = tailer.parseLine("");
    expect(events).toHaveLength(0);
  });

  test("handles assistant with non-array content", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: "just a string" },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(0);
  });

  test("handles unknown entry type", () => {
    const line = JSON.stringify({ type: "result", data: {} });
    const events = tailer.parseLine(line);
    expect(events).toHaveLength(0);
  });

  test("skips empty text blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "" }],
      },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(0);
  });

  test("skips empty thinking blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "" }],
      },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(0);
  });

  test("emits turn_boundary for channel-relay user message", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content:
          '<channel source="channel-relay" chat_id="-1" request_id="r1" user="u" ts="2026-04-22T15:00:00Z">\nhello\n</channel>',
      },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("turn_boundary");
    expect(events[0]!.content).toBe("");
    expect(events[1]!.type).toBe("user");
    expect(events[1]!.content).toBe("hello");
  });

  test("does not emit turn_boundary for empty user content", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: "" },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(0);
  });

  test("channel-tagged user message emits turn_boundary AND user event with originChat", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "text",
            text:
              '<channel source="channel-relay" chat_id="web" request_id="r1" ' +
              'user="web" ts="2026-04-23T09:44:29.709Z">hmmm</channel>',
          },
        ],
      },
    });
    const events = tailer.parseLine(line);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "turn_boundary" });
    expect(events[1]).toMatchObject({
      type: "user",
      content: "hmmm",
      originChat: "web",
    });
  });

  test("channel-tagged user message with Telegram chat id captures it as originChat", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "text",
            text:
              '<channel source="channel-relay" chat_id="-1003968796171" ' +
              'request_id="r2" user="azaidiuk" ts="2026-04-23T10:00:00.000Z">hello from tg</channel>',
          },
        ],
      },
    });
    const events = tailer.parseLine(line);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: "user",
      content: "hello from tg",
      originChat: "-1003968796171",
    });
  });

  test("native (non-tagged) user message emits user event with originChat undefined", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: "Fix the bug" },
    });
    const events = tailer.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "user", content: "Fix the bug" });
    expect(events[0]!.originChat).toBeUndefined();
  });

  test("mcp__channel-relay__reply emits relay_reply event with originChat from input.chat_id", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "mcp__channel-relay__reply",
            input: { request_id: "r1", chat_id: "web", text: "hello back" },
          },
        ],
      },
    });
    const events = tailer.parseLine(line);
    // relay_reply + turn_end (relay tool_uses don't suppress turn_end)
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "relay_reply",
      content: "hello back",
      originChat: "web",
    });
    expect(events[1]!.type).toBe("turn_end");
  });

  test("mcp__channel-relay__edit_message also carries originChat", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "mcp__channel-relay__edit_message",
            input: {
              chat_id: "-1003968796171",
              message_id: 42,
              text: "edited",
            },
          },
        ],
      },
    });
    const events = tailer.parseLine(line);
    // relay_reply + turn_end (relay tool_uses don't suppress turn_end)
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "relay_reply",
      content: "edited",
      originChat: "-1003968796171",
    });
    expect(events[1]!.type).toBe("turn_end");
  });

  test("native tool_use carries toolName and toolInput on the tool event", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: "/x/y.ts" },
          },
        ],
      },
    });
    const events = tailer.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool",
      toolName: "Read",
      toolInput: { file_path: "/x/y.ts" },
    });
  });

  test("permission-mode entry emits permission_mode event", () => {
    const line = JSON.stringify({
      type: "permission-mode",
      permissionMode: "plan",
      sessionId: "sess-1",
    });
    const events = tailer.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "permission_mode",
      content: "plan",
      permissionMode: "plan",
    });
  });

  test("permission-mode entry without a string permissionMode is dropped", () => {
    const line = JSON.stringify({
      type: "permission-mode",
      sessionId: "sess-1",
    });
    expect(tailer.parseLine(line)).toEqual([]);
  });

  test("repeated permission-mode with the same mode is deduped", () => {
    // Claude's runtime appends a permission-mode sentinel after every turn.
    // Without dedup these events touch typing under the liveness model and
    // hold the indicator up for the 120s safety window even when nothing is
    // happening. (Real-world repro: feat/typing-liveness, 2026-04-25.)
    const line = JSON.stringify({
      type: "permission-mode",
      permissionMode: "bypassPermissions",
      sessionId: "sess-1",
    });
    expect(tailer.parseLine(line)).toHaveLength(1);
    expect(tailer.parseLine(line)).toEqual([]);
    expect(tailer.parseLine(line)).toEqual([]);
  });

  test("permission-mode change after a same-mode emit re-emits", () => {
    const sameMode = JSON.stringify({
      type: "permission-mode",
      permissionMode: "bypassPermissions",
      sessionId: "sess-1",
    });
    const newMode = JSON.stringify({
      type: "permission-mode",
      permissionMode: "plan",
      sessionId: "sess-1",
    });
    expect(tailer.parseLine(sameMode)).toHaveLength(1);
    expect(tailer.parseLine(sameMode)).toEqual([]);
    const events = tailer.parseLine(newMode);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "permission_mode",
      permissionMode: "plan",
    });
  });

  test("system stop_hook_summary with errors emits hook_summary event", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "stop_hook_summary",
      hookCount: 3,
      hookErrors: [{ name: "lint", error: "Unfixable lint error" }],
      preventedContinuation: true,
    });
    const events = tailer.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "hook_summary",
      content: "Unfixable lint error",
      hook: {
        hookCount: 3,
        errorCount: 1,
        preventedContinuation: true,
        firstError: "Unfixable lint error",
        failingHookName: "lint",
      },
    });
  });

  test("system stop_hook_summary with no errors and no prevention is dropped", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "stop_hook_summary",
      hookCount: 2,
      hookErrors: [],
      preventedContinuation: false,
    });
    expect(tailer.parseLine(line)).toEqual([]);
  });

  test("system entries with other subtypes are ignored", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "turn_duration",
      durationMs: 2300,
    });
    expect(tailer.parseLine(line)).toEqual([]);
  });

  test("emits usage event from assistant entry", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 50_000,
          output_tokens: 40,
        },
      },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe("text");
    expect(events[1]).toMatchObject({
      type: "usage",
      content: "",
      usage: {
        input_tokens: 10,
        output_tokens: 40,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 50_000,
      },
    });
    expect(events[2]!.type).toBe("turn_end");
  });

  test("no usage event when usage block missing", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "ok" }] },
    });
    const events = tailer.parseLine(line);
    expect(events.find((e) => e.type === "usage")).toBeUndefined();
  });

  test("assistant with only text emits turn_end at end", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "All done." }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });

    const events = tailer.parseLine(line);
    const types = events.map((e) => e.type);
    expect(types).toContain("turn_end");
    expect(types[types.length - 1]).toBe("turn_end");
  });

  test("assistant with tool_use does NOT emit turn_end", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Reading file..." },
          {
            type: "tool_use",
            id: "tu_1",
            name: "Read",
            input: { file_path: "/x" },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });

    const events = tailer.parseLine(line);
    expect(events.map((e) => e.type)).not.toContain("turn_end");
  });

  test("assistant with text + relay-reply emits turn_end (final user-visible reply)", () => {
    // The final Claude reply lands as text + a mcp__channel-relay__reply
    // tool_use. Relay tool_uses surface as `relay_reply` events, not `tool`,
    // so they don't count toward "still working". Typing should drop once
    // the user has seen the answer.
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "All done." },
          {
            type: "tool_use",
            id: "tu_1",
            name: "mcp__channel-relay__reply",
            input: { chat_id: "-100", request_id: "r1", text: "All done." },
          },
        ],
      },
    });

    const events = tailer.parseLine(line);
    const types = events.map((e) => e.type);
    expect(types).toContain("turn_end");
    expect(types[types.length - 1]).toBe("turn_end");
  });

  test("assistant with thinking + text (no tool_use) emits turn_end", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "thought" },
          { type: "text", text: "Final answer." },
        ],
      },
    });

    const events = tailer.parseLine(line);
    expect(events.map((e) => e.type)).toEqual(["thinking", "text", "turn_end"]);
  });

  test("assistant with empty content does NOT emit turn_end", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [] },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(0);
  });

  test("parses message-format assistant text block (no top-level type)", () => {
    const line = JSON.stringify({
      parentUuid: "abc123",
      isSidechain: false,
      message: {
        model: "claude-opus-4-7",
        id: "msg_01abc",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello from message format" }],
      },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("text");
    expect(events[0]!.content).toBe("Hello from message format");
    expect(events[1]!.type).toBe("turn_end");
  });

  test("parses message-format assistant tool_use block (no top-level type)", () => {
    const line = JSON.stringify({
      parentUuid: "abc123",
      isSidechain: false,
      message: {
        model: "claude-opus-4-7",
        id: "msg_01abc",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "Read",
            input: { file_path: "/tmp/test.ts" },
          },
        ],
      },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("tool");
    expect(events[0]!.content).toContain("Reading");
  });

  test("parses message-format assistant thinking block (no top-level type)", () => {
    const line = JSON.stringify({
      parentUuid: "abc123",
      isSidechain: false,
      message: {
        model: "claude-opus-4-7",
        id: "msg_01abc",
        type: "message",
        role: "assistant",
        content: [{ type: "thinking", thinking: "Let me reason..." }],
      },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("thinking");
    expect(events[1]!.type).toBe("turn_end");
  });
});

// ============== findSessionJsonlPath ==============

describe("tailer: findSessionJsonlPath", () => {
  test("returns null for non-existent session ID", async () => {
    const result = await findSessionJsonlPath(
      `non-existent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    expect(result).toBeNull();
  });

  test("returns null for empty session ID", async () => {
    const result = await findSessionJsonlPath("");
    expect(result).toBeNull();
  });

  test("returns a .jsonl path for a real session if one exists", async () => {
    // Scan ~/.claude/projects for any existing session file to test with
    const { homedir } = await import("os");
    const { readdir } = await import("fs/promises");
    const projectsDir = join(homedir(), ".claude", "projects");

    let realSessionId: string | null = null;
    try {
      const projects = await readdir(projectsDir);
      for (const project of projects) {
        if (project.startsWith(".")) continue;
        const files = await readdir(join(projectsDir, project)).catch(() => []);
        const jsonl = files.find((f: string) => f.endsWith(".jsonl"));
        if (jsonl) {
          realSessionId = jsonl.replace(".jsonl", "");
          break;
        }
      }
    } catch {
      // No projects dir
    }

    if (!realSessionId) {
      // Skip if no real sessions available
      return;
    }

    const result = await findSessionJsonlPath(realSessionId);
    expect(result).not.toBeNull();
    expect(result!).toEndWith(`${realSessionId}.jsonl`);
  });
});

// ============== getExpectedJsonlPath ==============

describe("tailer: getExpectedJsonlPath", () => {
  test("encodes a simple cwd by replacing slashes with dashes", () => {
    const path = getExpectedJsonlPath("/Users/ali/Dev/athletiq", "abc-123");
    expect(path).toEndWith(
      "/.claude/projects/-Users-ali-Dev-athletiq/abc-123.jsonl",
    );
  });

  test("encodes dots in the cwd as dashes (worktree paths)", () => {
    const path = getExpectedJsonlPath(
      "/Users/ali/Dev/claude-mobile-bridge/.claude/worktrees/reverent-neumann",
      "f9523856",
    );
    expect(path).toEndWith(
      "/.claude/projects/-Users-ali-Dev-claude-mobile-bridge--claude-worktrees-reverent-neumann/f9523856.jsonl",
    );
  });
});

// ============== SessionTailer lifecycle ==============

describe("tailer: lifecycle", () => {
  const testFile = join(tmpdir(), `tailer-test-${Date.now()}.jsonl`);

  beforeEach(async () => {
    await writeFile(testFile, "");
  });

  afterEach(async () => {
    await rm(testFile, { force: true });
  });

  test("start sets offset to current file size", async () => {
    await writeFile(testFile, '{"type":"user"}\n');

    const events: TailEvent[] = [];
    const tailer = new SessionTailer(testFile, (e) => events.push(e));
    await tailer.start();
    tailer.stop();

    // Should not have emitted the existing content (started from EOF)
    expect(events).toHaveLength(0);
  });

  test("stop cleans up without errors", async () => {
    const tailer = new SessionTailer(testFile, () => {});
    await tailer.start();
    tailer.stop();
    // Double stop should be safe
    tailer.stop();
  });

  test("emits events for newly appended lines", async () => {
    const events: TailEvent[] = [];
    const tailer = new SessionTailer(testFile, (e) => events.push(e));
    await tailer.start();

    // Append a new line
    const { appendFile } = await import("fs/promises");
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "New content" }] },
    });
    await appendFile(testFile, line + "\n");

    // Wait for polling to pick it up (poll interval is 2s)
    await new Promise((resolve) => setTimeout(resolve, 2200));

    tailer.stop();

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.type).toBe("text");
    expect(events[0]!.content).toBe("New content");
  });

  test("starts on a non-existent path and tails it once it appears", async () => {
    const lateFile = join(tmpdir(), `tailer-late-${Date.now()}.jsonl`);
    // Ensure the file does NOT exist when start() is called.
    await rm(lateFile, { force: true });

    const events: TailEvent[] = [];
    const tailer = new SessionTailer(lateFile, (e) => events.push(e));
    try {
      await tailer.start();

      // Create the file with one line after start.
      const line = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Late content" }] },
      });
      await writeFile(lateFile, line + "\n");

      // Polling interval is 2s; wait long enough for it to fire.
      await new Promise((resolve) => setTimeout(resolve, 2200));

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]!.type).toBe("text");
      expect(events[0]!.content).toBe("Late content");
    } finally {
      tailer.stop();
      await rm(lateFile, { force: true });
    }
  });
});

// ============== tool_result events ==============

describe("tailer: parseLine – tool_result events", () => {
  let tailer: SessionTailer;

  beforeEach(() => {
    tailer = new SessionTailer("/dev/null", () => {});
  });

  test("user message with single tool_result emits tool_result event", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_123",
            content: "file contents here",
            is_error: false,
          },
        ],
      },
    });
    const events = tailer.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool_result",
      content: "file contents here",
      toolUseId: "tu_123",
      isError: false,
    });
  });

  test("user message with tool_result whose content is a block array flattens text", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_456",
            content: [
              { type: "text", text: "first" },
              { type: "text", text: "second" },
            ],
            is_error: true,
          },
        ],
      },
    });
    const events = tailer.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool_result",
      content: "first\nsecond",
      toolUseId: "tu_456",
      isError: true,
    });
  });

  test("user message with multiple tool_result blocks emits one event per block", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "a", content: "one" },
          { type: "tool_result", tool_use_id: "b", content: "two" },
        ],
      },
    });
    const events = tailer.parseLine(line);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "a",
      content: "one",
    });
    expect(events[1]).toMatchObject({
      type: "tool_result",
      toolUseId: "b",
      content: "two",
    });
  });

  test("tool_result without tool_use_id is dropped", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", content: "orphan" }],
      },
    });
    expect(tailer.parseLine(line)).toEqual([]);
  });

  test("tool_result for a channel-relay reply tool_use is suppressed", () => {
    // Channel-relay tool_use blocks emit `relay_reply` (or nothing for react)
    // and a `turn_end` — typing stops. Their matching tool_result must NOT
    // become a `tool_result` event, otherwise the watch's liveness handler
    // re-arms typing after turn_end and the indicator hangs until the safety
    // timeout. (Real-world repro: feat/typing-liveness, 2026-04-25.)
    const replyLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tu_relay_reply_1",
            name: "mcp__channel-relay__reply",
            input: { chat_id: "-100", request_id: "r1", text: "hi" },
          },
        ],
      },
    });
    const resultLine = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_relay_reply_1",
            content: "Sent reply to -100",
          },
        ],
      },
    });

    const replyEvents = tailer.parseLine(replyLine);
    expect(replyEvents.map((e) => e.type)).toEqual(["relay_reply", "turn_end"]);
    expect(tailer.parseLine(resultLine)).toEqual([]);
  });

  test("tool_result for a channel-relay react tool_use is suppressed", () => {
    const reactLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tu_relay_react_1",
            name: "mcp__channel-relay__react",
            input: { chat_id: "-100", message_id: 7, emoji: "👍" },
          },
        ],
      },
    });
    const resultLine = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_relay_react_1",
            content: "ok",
          },
        ],
      },
    });

    expect(tailer.parseLine(reactLine)).toEqual([]);
    expect(tailer.parseLine(resultLine)).toEqual([]);
  });

  test("tool_result for a channel-relay edit_message tool_use is suppressed", () => {
    const editLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tu_relay_edit_1",
            name: "mcp__channel-relay__edit_message",
            input: { chat_id: "-100", message_id: 7, text: "edited" },
          },
        ],
      },
    });
    const resultLine = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_relay_edit_1",
            content: "ok",
          },
        ],
      },
    });

    const editEvents = tailer.parseLine(editLine);
    expect(editEvents.map((e) => e.type)).toEqual(["relay_reply", "turn_end"]);
    expect(tailer.parseLine(resultLine)).toEqual([]);
  });
});
