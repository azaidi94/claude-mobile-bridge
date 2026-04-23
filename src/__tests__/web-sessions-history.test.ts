import "./ensure-test-env";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "sess-history-"));
  process.env.CLAUDE_DIR = TMP;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.CLAUDE_DIR;
});

async function load() {
  return import("../web/sessions/history");
}

function writeFixture(sessionId: string, lines: unknown[]): void {
  const projectsDir = join(TMP, "projects", "-Users-x-proj");
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(
    join(projectsDir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

describe("readSessionHistory", () => {
  test("returns empty array when JSONL is missing", async () => {
    const { readSessionHistory } = await load();
    const events = await readSessionHistory("missing-sid", 100);
    expect(events).toEqual([]);
  });

  test("native (non-channel-tagged) user text is prefixed with 🖥 for Desktop turn", async () => {
    const sid = "sid-user-string";
    writeFixture(sid, [
      { type: "user", message: { role: "user", content: "hello" } },
    ]);
    const { readSessionHistory } = await load();
    const events = await readSessionHistory(sid, 100);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "text", content: "🖥 hello" });
  });

  test("channel-relay-tagged user text is stripped and prefixed with › for You turn", async () => {
    const sid = "sid-user-channel";
    writeFixture(sid, [
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text:
                '<channel source="channel-relay" chat_id="web" request_id="r1" user="web" ts="2026-04-23T09:44:29.709Z">' +
                "hmmm" +
                "</channel>",
            },
          ],
        },
      },
    ]);
    const { readSessionHistory } = await load();
    const events = await readSessionHistory(sid, 100);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "text", content: "› hmmm" });
  });

  test("skips user tool_result messages", async () => {
    const sid = "sid-tool-result";
    writeFixture(sid, [
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }],
        },
      },
    ]);
    const { readSessionHistory } = await load();
    const events = await readSessionHistory(sid, 100);
    expect(events).toEqual([]);
  });

  test("maps assistant text, thinking, and tool_use blocks", async () => {
    const sid = "sid-assist";
    writeFixture(sid, [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "pondering" },
            { type: "text", text: "Hello **there**" },
            { type: "tool_use", name: "Read", input: { file_path: "/a" } },
          ],
        },
      },
    ]);
    const { readSessionHistory } = await load();
    const events = await readSessionHistory(sid, 100);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: "thinking", content: "pondering" });
    expect(events[1]).toMatchObject({
      type: "text",
      content: "Hello **there**",
    });
    expect(events[2]!.type).toBe("tool");
    expect(events[2]!.content).toContain("Read"); // formatted tool string
  });

  test("surfaces mcp__channel-relay__reply as text from input.text", async () => {
    const sid = "sid-relay-reply";
    writeFixture(sid, [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "mcp__channel-relay__reply",
              input: {
                request_id: "r1",
                chat_id: "c1",
                text: "hello from Claude",
              },
            },
          ],
        },
      },
    ]);
    const { readSessionHistory } = await load();
    const events = await readSessionHistory(sid, 100);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "text",
      content: "hello from Claude",
    });
  });

  test("surfaces mcp__channel-relay__edit_message as text and skips react", async () => {
    const sid = "sid-relay-edit-react";
    writeFixture(sid, [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "mcp__channel-relay__edit_message",
              input: { chat_id: "c1", message_id: 1, text: "edited" },
            },
            {
              type: "tool_use",
              name: "mcp__channel-relay__react",
              input: { chat_id: "c1", message_id: 1, emoji: "👍" },
            },
          ],
        },
      },
    ]);
    const { readSessionHistory } = await load();
    const events = await readSessionHistory(sid, 100);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "text", content: "edited" });
  });

  test("ignores noise entries (attachment, permission-mode, malformed)", async () => {
    const sid = "sid-noise";
    const path = join(TMP, "projects", "-p");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, `${sid}.jsonl`),
      [
        JSON.stringify({ type: "permission-mode" }),
        JSON.stringify({ type: "attachment" }),
        "not json {",
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "kept" },
        }),
      ].join("\n") + "\n",
    );
    const { readSessionHistory } = await load();
    const events = await readSessionHistory(sid, 100);
    expect(events).toHaveLength(1);
    expect(events[0]!.content).toBe("🖥 kept");
  });

  test("caps to the last N events when limit is exceeded", async () => {
    const sid = "sid-limit";
    const lines = Array.from({ length: 50 }, (_, i) => ({
      type: "user",
      message: { role: "user", content: `msg${i}` },
    }));
    writeFixture(sid, lines);
    const { readSessionHistory } = await load();
    const events = await readSessionHistory(sid, 10);
    expect(events).toHaveLength(10);
    expect(events[0]!.content).toBe("🖥 msg40");
    expect(events[9]!.content).toBe("🖥 msg49");
  });
});
