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
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("text");
    expect(events[0]!.content).toBe("Hello world");
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
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("thinking");
    expect(events[0]!.content).toBe("Let me think about this...");
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
    expect(events).toHaveLength(1);
    expect(events[0]!.content.length).toBeLessThan(250);
    expect(events[0]!.content).toEndWith("...");
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

  test("skips user tool_result-only messages", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "abc", content: "ok" }],
      },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(0);
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
