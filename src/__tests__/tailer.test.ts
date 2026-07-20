/**
 * Unit tests for SessionTailer (sessions/tailer.ts).
 *
 * Tests JSONL line parsing, event emission, and session file discovery.
 */

import "./ensure-test-env";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { writeFile, rm, mkdtemp, mkdir, utimes } from "fs/promises";
import { join } from "path";
import { tmpdir, homedir } from "os";

// Import directly from source to avoid barrel export issues
import {
  SessionTailer,
  findSessionJsonlPath,
  findNewestSessionInDir,
  getExpectedJsonlPath,
  encodeProjectPath,
  isSessionTranscript,
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

  test("stamps eventId as `${uuid}:${blockIndex}` for render-path blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "abc-123",
      message: {
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "tool_use", name: "Read", input: { file_path: "/a.ts" } },
          { type: "text", text: "done" },
        ],
      },
    });

    const events = tailer.parseLine(line);
    // Two racing tailers reading this same line produce identical eventIds,
    // so the bus dedup cache collapses the duplicate posts.
    expect(events[0]!.eventId).toBe("abc-123:0"); // thinking
    expect(events[1]!.eventId).toBe("abc-123:1"); // tool
    expect(events[2]!.eventId).toBe("abc-123:2"); // text
  });

  test("eventId is undefined when the entry has no uuid", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    });

    const events = tailer.parseLine(line);
    expect(events[0]!.type).toBe("text");
    expect(events[0]!.eventId).toBeUndefined();
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

  test("emits image event for tool_result image block (before tool_result)", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "shot1",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: "AAAA",
                },
              },
            ],
          },
        ],
      },
    });

    const events = tailer.parseLine(line);
    // image emitted before its tool_result so the tool name can be resolved
    expect(events[0]).toMatchObject({
      type: "image",
      toolUseId: "shot1",
      image: { mediaType: "image/jpeg", dataBase64: "AAAA" },
    });
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
  });

  test("emits image event for top-level pasted image (no toolUseId)", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "text", text: "look at this" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "BBBB" },
          },
        ],
      },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(1);
    const img = events[0]!;
    expect(img).toMatchObject({
      type: "image",
      content: "look at this", // accompanying text folded into the caption
      image: { mediaType: "image/png", dataBase64: "BBBB" },
    });
    expect(img.toolUseId).toBeUndefined();
    // no separate user-text echo — the text is now the image's caption
    expect(events.some((e) => e.type === "user")).toBe(false);
  });

  test("strips [Image #N] marker, folding only real text into the caption", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "text", text: "[Image #2] testing pasting in terminal" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "ZZ" },
          },
        ],
      },
    });
    const events = tailer.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "image",
      content: "testing pasting in terminal",
    });
  });

  test("marker-only paste text yields an image with empty caption", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "text", text: "[Image #5]" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "QQ" },
          },
        ],
      },
    });
    const events = tailer.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "image", content: "" });
  });

  test("surfaces @-referenced image uploads with remaining text as caption", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: '@"/Users/x/.claude/uploads/s/IMG_6507.png" look at this',
      },
    });
    const events = tailer.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "image",
      content: "look at this",
      image: { path: "/Users/x/.claude/uploads/s/IMG_6507.png" },
    });
  });

  test("non-image @-mentions stay as plain user text (not surfaced)", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: '@"/src/foo.ts" explain this' },
    });
    const events = tailer.parseLine(line);
    expect(events.some((e) => e.type === "image")).toBe(false);
    expect(events.find((e) => e.type === "user")?.content).toContain("foo.ts");
  });

  test("drops standalone [Image: source: /tmp/...] annotation entries", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "text",
            text: "[Image: source: /var/folders/x/T/clipboard-1.png]",
          },
        ],
      },
    });
    expect(tailer.parseLine(line)).toHaveLength(0);
  });

  test("does NOT surface images from relay-wrapped (TG-origin) messages", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "text",
            text: '<channel source="channel-relay" chat_id="-1" request_id="r1" user="u" ts="2026-04-22T15:00:00Z">\nhi\n</channel>',
          },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "CCCC" },
          },
        ],
      },
    });

    const events = tailer.parseLine(line);
    expect(events.some((e) => e.type === "image")).toBe(false);
  });

  test("suppresses the Read tool_result image of a Telegram-origin photo", () => {
    // User sends a photo via TG → relay stamps image_path on the <channel> tag.
    const userLine = JSON.stringify({
      type: "user",
      message: {
        content:
          '<channel source="channel-relay" chat_id="-1" request_id="r1" user="u" ts="2026-06-21T00:00:00Z" image_path="/tmp/telegram-bot/photo_1_a.jpg">\nlook at this\n</channel>',
      },
    });
    // Claude reads that exact path to look at it.
    const readLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tu_read_1",
            name: "Read",
            input: { file_path: "/tmp/telegram-bot/photo_1_a.jpg" },
          },
        ],
      },
    });
    // The Read result carries the photo back as a base64 image block.
    const resultLine = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_read_1",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: "PP",
                },
              },
            ],
          },
        ],
      },
    });

    tailer.parseLine(userLine);
    expect(tailer.parseLine(readLine).some((e) => e.type === "tool")).toBe(
      true,
    );
    const resultEvents = tailer.parseLine(resultLine);
    // No echoed photo, but the Read still registers as a tool_result.
    expect(resultEvents.some((e) => e.type === "image")).toBe(false);
    expect(resultEvents.some((e) => e.type === "tool_result")).toBe(true);
  });

  test("still surfaces a Read image when the path is not Telegram-origin", () => {
    const userLine = JSON.stringify({
      type: "user",
      message: {
        content:
          '<channel source="channel-relay" chat_id="-1" request_id="r1" user="u" ts="2026-06-21T00:00:00Z" image_path="/tmp/telegram-bot/photo_2_b.jpg">\nhi\n</channel>',
      },
    });
    // Claude reads a DIFFERENT image (e.g. one it found in the repo).
    const readLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tu_read_2",
            name: "Read",
            input: { file_path: "/Users/x/repo/diagram.png" },
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
            tool_use_id: "tu_read_2",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "QQ" },
              },
            ],
          },
        ],
      },
    });

    tailer.parseLine(userLine);
    tailer.parseLine(readLine);
    const resultEvents = tailer.parseLine(resultLine);
    expect(resultEvents.some((e) => e.type === "image")).toBe(true);
  });

  test("defaults unknown media_type and ignores non-base64 image sources", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "x",
            content: [
              { type: "image", source: { type: "url", url: "http://x/y.png" } },
              { type: "image", source: { type: "base64", data: "DDDD" } },
            ],
          },
        ],
      },
    });

    const events = tailer.parseLine(line);
    const imgs = events.filter((e) => e.type === "image");
    // url source dropped, base64 kept with default media_type
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.image).toMatchObject({
      mediaType: "image/png",
      dataBase64: "DDDD",
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

  test("does not treat type:user entry with message.role:assistant as assistant", () => {
    // Safety: the type:user branch must win over the message.role check
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "assistant",
        content: "should not be treated as assistant",
      },
    });

    const events = tailer.parseLine(line);
    // Should produce a user event or empty (user branch handles it), NOT a text/turn_end pair
    expect(
      events.every(
        (e) =>
          e.type !== "text" &&
          e.type !== "turn_end" &&
          e.type !== "thinking" &&
          e.type !== "tool",
      ),
    ).toBe(true);
  });

  test("ignores message-format entry with role:user (no top-level type)", () => {
    // A no-top-level-type entry with role:user should not be treated as assistant
    const line = JSON.stringify({
      parentUuid: "abc123",
      isSidechain: false,
      message: {
        role: "user",
        content: [{ type: "text", text: "user message" }],
      },
    });

    const events = tailer.parseLine(line);
    expect(events).toHaveLength(0);
  });

  test("emits user event for task-notification attachment", () => {
    const xml =
      "<task-notification>\n" +
      "<task-id>bxds11oof</task-id>\n" +
      "<status>completed</status>\n" +
      "<summary>Background command done</summary>\n" +
      "</task-notification>";
    const line = JSON.stringify({
      type: "attachment",
      attachment: {
        type: "queued_command",
        prompt: xml,
        commandMode: "task-notification",
      },
    });
    const events = tailer.parseLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("user");
    expect(events[0]!.content).toContain("<task-notification>");
    expect(events[0]!.content).toContain("Background command done");
  });

  test("ignores non-task-notification attachments", () => {
    const line = JSON.stringify({
      type: "attachment",
      attachment: { type: "task_reminder", content: [], itemCount: 0 },
    });
    expect(tailer.parseLine(line)).toHaveLength(0);
  });

  test("AskUserQuestion emits ask_user_question event, suppresses default tool", () => {
    const tailer = new SessionTailer("/dev/null", () => {});
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Pick a database?",
                  options: [
                    { label: "Postgres", description: "Strong" },
                    { label: "SQLite", description: "Embedded" },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
    const events = tailer.parseLine(line);
    const auq = events.filter((e) => e.type === "ask_user_question");
    const tools = events.filter((e) => e.type === "tool");
    const turnEnd = events.filter((e) => e.type === "turn_end");
    expect(auq).toHaveLength(1);
    expect(tools).toHaveLength(0);
    expect(turnEnd).toHaveLength(1);
    expect(auq[0]!.questions).toBeDefined();
    expect(auq[0]!.questions!).toHaveLength(1);
    expect(auq[0]!.questions![0]!.question).toBe("Pick a database?");
    expect(auq[0]!.questions![0]!.options).toHaveLength(2);
  });

  test("AskUserQuestion alongside another tool_use emits both events", () => {
    const tailer = new SessionTailer("/dev/null", () => {});
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: "/x.ts" },
          },
          {
            type: "tool_use",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Continue?",
                  options: [{ label: "Yes" }, { label: "No" }],
                },
              ],
            },
          },
        ],
      },
    });
    const events = tailer.parseLine(line);
    const types = events.map((e) => e.type);
    expect(types).toContain("tool");
    expect(types).toContain("ask_user_question");
    // Has a real tool_use → no turn_end emitted.
    expect(types).not.toContain("turn_end");
  });

  test("AskUserQuestion with malformed input emits event with empty questions", () => {
    const tailer = new SessionTailer("/dev/null", () => {});
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "AskUserQuestion",
            input: {},
          },
        ],
      },
    });
    const events = tailer.parseLine(line);
    const auq = events.filter((e) => e.type === "ask_user_question");
    expect(auq).toHaveLength(1);
    expect(auq[0]!.questions).toEqual([]);
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

// ============== isSessionTranscript ==============

describe("tailer: isSessionTranscript", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "transcript-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("rejects a metadata-only title/name stub", async () => {
    // The exact shape Claude Code writes for its session-naming sidecar.
    const stub =
      JSON.stringify({
        type: "ai-title",
        aiTitle: "Debug clinical_notes column schema cache error",
        sessionId: "e140fac1",
      }) +
      "\n" +
      JSON.stringify({
        type: "agent-name",
        agentName: "Debug clinical_notes column schema cache error",
        sessionId: "e140fac1",
      }) +
      "\n";
    const p = join(dir, "stub.jsonl");
    await writeFile(p, stub);
    expect(await isSessionTranscript(p)).toBe(false);
  });

  test("accepts a transcript with a user turn", async () => {
    const p = join(dir, "real.jsonl");
    await writeFile(
      p,
      JSON.stringify({ type: "ai-title", aiTitle: "x" }) +
        "\n" +
        JSON.stringify({ type: "user", message: { content: "hi" } }) +
        "\n",
    );
    expect(await isSessionTranscript(p)).toBe(true);
  });

  test("accepts a transcript that carries a cwd but no turn yet", async () => {
    const p = join(dir, "cwd.jsonl");
    await writeFile(
      p,
      JSON.stringify({ type: "attachment", cwd: "/Users/x/proj" }) + "\n",
    );
    expect(await isSessionTranscript(p)).toBe(true);
  });

  test("rejects an empty file", async () => {
    const p = join(dir, "empty.jsonl");
    await writeFile(p, "");
    expect(await isSessionTranscript(p)).toBe(false);
  });

  test("returns false for a missing file", async () => {
    expect(await isSessionTranscript(join(dir, "nope.jsonl"))).toBe(false);
  });
});

// ============== findNewestSessionInDir ==============

describe("tailer: findNewestSessionInDir", () => {
  // findNewestSessionInDir resolves against the real ~/.claude/projects via
  // PROJECTS_DIR, so — like history.test.ts — we materialize a real project
  // dir under an encoded, unique cwd and tear it down afterwards.
  let cwd: string;
  let projectDir: string;

  beforeEach(async () => {
    cwd = join(tmpdir(), `newest-session-${Date.now()}-${process.pid}`);
    projectDir = join(homedir(), ".claude", "projects", encodeProjectPath(cwd));
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  const TRANSCRIPT =
    JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n";
  const STUB =
    JSON.stringify({ type: "ai-title", aiTitle: "x", sessionId: "s" }) + "\n";

  async function writeJsonl(id: string, body: string, mtimeSec: number) {
    const p = join(projectDir, `${id}.jsonl`);
    await writeFile(p, body);
    await utimes(p, mtimeSec, mtimeSec);
  }

  test("returns the real transcript even when a stub was touched more recently", async () => {
    // The regression: a stale-but-real transcript, plus a freshly-touched
    // metadata stub that sorts newest by mtime. Must still pick the real one.
    await writeJsonl("real-session", TRANSCRIPT, 1000);
    await writeJsonl("title-stub", STUB, 2000);

    expect(await findNewestSessionInDir(cwd)).toBe("real-session");
  });

  test("returns null when only stubs exist", async () => {
    await writeJsonl("stub-a", STUB, 1000);
    await writeJsonl("stub-b", STUB, 2000);

    expect(await findNewestSessionInDir(cwd)).toBeNull();
  });

  test("picks the newest among multiple real transcripts", async () => {
    await writeJsonl("older-real", TRANSCRIPT, 1000);
    await writeJsonl("newer-real", TRANSCRIPT, 2000);

    expect(await findNewestSessionInDir(cwd)).toBe("newer-real");
  });

  test("honours excludeIds", async () => {
    await writeJsonl("excluded-real", TRANSCRIPT, 2000);
    await writeJsonl("kept-real", TRANSCRIPT, 1000);

    expect(await findNewestSessionInDir(cwd, new Set(["excluded-real"]))).toBe(
      "kept-real",
    );
  });
});

// ============== encodeProjectPath ==============

describe("tailer: encodeProjectPath", () => {
  test("replaces slashes with dashes", () => {
    expect(encodeProjectPath("/Users/ali/Dev/foo")).toBe("-Users-ali-Dev-foo");
  });

  test("replaces dots with dashes", () => {
    expect(encodeProjectPath("/path/to/.claude/worktrees")).toBe(
      "-path-to--claude-worktrees",
    );
  });

  test("handles paths with no special chars", () => {
    expect(encodeProjectPath("myproject")).toBe("myproject");
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

  test("startFromBeginning() reads existing file content from offset 0 (drift restart)", async () => {
    // Simulates the watch.ts drift path: a fresh JSONL has the user's first
    // prompt already on disk before our tailer attaches. Without this opt-in,
    // EOF positioning would skip the message and TG would lose it (the bug
    // that hit saas-builder on 2026-05-10).
    const userLine = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: "review https://github.com/example/foo and propose changes",
      },
    });
    await writeFile(testFile, userLine + "\n");

    const events: TailEvent[] = [];
    const tailer = new SessionTailer(testFile, (e) => events.push(e));
    tailer.startFromBeginning();
    await tailer.start();
    // Allow the initial readNew() to flush.
    await new Promise((r) => setTimeout(r, 50));
    tailer.stop();

    expect(events.length).toBeGreaterThanOrEqual(1);
    const userEvt = events.find((e) => e.type === "user");
    expect(userEvt).toBeDefined();
    expect(userEvt!.content).toContain("review https://github.com/example/foo");
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

  test("recovers after the file is truncated/rewritten below the saved offset", async () => {
    // Regression: readNew()'s `size <= offset` guard used to bail forever once
    // a watched JSONL shrank below the saved offset (in-place rewrite). The
    // tailer then went silently dead for that session — assistant output still
    // arrived via the relay TCP path, masking it, but native terminal input
    // (tailer-only) vanished. Recovery resyncs the offset to the new EOF and
    // resumes emitting subsequent appends.
    const events: TailEvent[] = [];

    // Large initial content so start() seeks to a high offset.
    const bigLine = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "x".repeat(2000) }] },
    });
    await writeFile(testFile, bigLine + "\n");

    const tailer = new SessionTailer(testFile, (e) => events.push(e));
    await tailer.start(); // offset == big size
    try {
      // Rewrite the file far smaller than the saved offset (simulates a
      // compaction / in-place rewrite). This is what used to wedge readNew.
      await writeFile(testFile, "");
      // Let one poll detect the shrink and resync the offset to the new EOF.
      await new Promise((resolve) => setTimeout(resolve, 2200));

      // A subsequent append must now be picked up — proving the tailer is
      // alive again rather than stuck on the stale offset.
      const { appendFile } = await import("fs/promises");
      const newLine = JSON.stringify({
        type: "user",
        message: { role: "user", content: "post-truncation input" },
      });
      await appendFile(testFile, newLine + "\n");
      await new Promise((resolve) => setTimeout(resolve, 2200));

      const userEvt = events.find((e) => e.type === "user");
      expect(userEvt).toBeDefined();
      expect(userEvt!.content).toBe("post-truncation input");
    } finally {
      tailer.stop();
    }
  });

  test("torn-write: partial line is not permanently lost; multi-byte char handled", async () => {
    // Simulates a writer that is mid-append when the tailer fires.
    // entry1 contains a multi-byte UTF-8 character (é = 2 bytes) to verify
    // that byte-offset accounting is correct.
    const entry1 = JSON.stringify({
      type: "user",
      message: { content: "héllo" },
    });
    const entry2 = JSON.stringify({
      type: "user",
      message: { content: "wörld" },
    });
    // Partial: first entry complete, second entry truncated mid-JSON (no newline).
    const partial2 = entry2.slice(0, Math.floor(entry2.length / 2));

    const events: TailEvent[] = [];
    const tailer = new SessionTailer(testFile, (e) => events.push(e));
    tailer.startFromBeginning();
    await tailer.start();

    const { appendFile } = await import("fs/promises");
    await appendFile(testFile, entry1 + "\n" + partial2);

    // Wait for poll to fire and process the first complete line only.
    await new Promise((r) => setTimeout(r, 2200));

    const afterPartial = events.filter((e) => e.type === "user");
    expect(afterPartial).toHaveLength(1);
    expect(afterPartial[0]!.content).toBe("héllo");

    // Complete the second entry and let the tailer pick it up.
    const rest2 = entry2.slice(Math.floor(entry2.length / 2));
    await appendFile(testFile, rest2 + "\n");
    await new Promise((r) => setTimeout(r, 2200));

    const afterComplete = events.filter((e) => e.type === "user");
    expect(afterComplete).toHaveLength(2);
    expect(afterComplete[1]!.content).toBe("wörld");

    tailer.stop();
  });

  test("stop() in callback halts delivery of subsequent events in the same read", async () => {
    // Write several lines so the tailer processes multiple events per read.
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ type: "user", message: { content: `msg${i}` } }),
    ).join("\n");
    await writeFile(testFile, lines + "\n");

    let callCount = 0;
    let tailerRef: SessionTailer;
    const tailer = new SessionTailer(testFile, () => {
      callCount++;
      tailerRef!.stop();
    });
    tailerRef = tailer;

    tailer.startFromBeginning();
    await tailer.start();
    await new Promise((r) => setTimeout(r, 100));

    // stop() is called inside the first callback. The doRead loop checks
    // this.stopped before each subsequent delivery, so only 1 event fires.
    expect(callCount).toBe(1);
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
