import "./ensure-test-env";
import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { Api } from "grammy";
import { createMessageBus, setMessageBus } from "../messaging/bus";
import { buildWatchState } from "../handlers/watch/state";
import { renderTool, renderThinking } from "../handlers/watch/tool-headers";
import { renderText } from "../handlers/watch/text-renderer";
import type { TailEvent } from "../sessions/tailer";

// Two live tailers on one topic (a documented jsonl-tailer leak race) each
// render every block, so a card posts 2×/3×. The tailer stamps a stable
// `eventId` (`${uuid}:${idx}`) on each block; the render path forwards it as the
// bus `dedupKey`. Both tailers produce the SAME key for a given block, so the
// bus's 60s dedup cache drops the second copy. These tests drive two states
// through the real bus and assert exactly one Telegram send per block.

function makeApi() {
  const sent: { chatId: number; text: string }[] = [];
  let counter = 1000;
  const sendMessage = mock((chatId: number, text: string) => {
    sent.push({ chatId, text });
    return Promise.resolve({ message_id: counter++ });
  });
  const editMessageText = mock(() => Promise.resolve({ message_id: 1 }));
  const deleteMessage = mock(() => Promise.resolve(true));
  return {
    api: { sendMessage, editMessageText, deleteMessage } as unknown as Api,
    sent,
  };
}

const CHAT = 555;
const THREAD = 7;

function stateA() {
  return buildWatchState({
    sessionName: "S",
    sessionId: "id-a",
    sessionDir: "/proj",
    chatId: CHAT,
    threadId: THREAD,
  });
}
function stateB() {
  return buildWatchState({
    sessionName: "S",
    sessionId: "id-b",
    sessionDir: "/proj",
    chatId: CHAT,
    threadId: THREAD,
  });
}

// Let all fire-and-forget bus.send().then() chains settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("watch render dedup — two tailers, one topic", () => {
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    api = makeApi();
    setMessageBus(createMessageBus(api.api));
  });

  test("a tool card with the same eventId is posted once, not twice", async () => {
    const event: TailEvent = {
      type: "tool",
      content: "📖 Reading watch/ContentView.swift",
      toolName: "Read",
      toolInput: { file_path: "/watch/ContentView.swift" },
      toolUseId: "toolu_1",
      eventId: "uuid-1:0",
    };
    // Two independent tailers render the identical block.
    renderTool(api.api, stateA(), event, THREAD);
    renderTool(api.api, stateB(), event, THREAD);
    await flush();

    expect(api.sent).toHaveLength(1);
  });

  test("distinct tool blocks (distinct eventIds) both post", async () => {
    const mk = (id: string): TailEvent => ({
      type: "tool",
      content: "📖 Reading a.ts",
      toolName: "Read",
      toolInput: { file_path: "/a.ts" },
      toolUseId: id,
      eventId: `uuid-1:${id}`,
    });
    renderTool(api.api, stateA(), mk("0"), THREAD);
    renderTool(api.api, stateA(), mk("1"), THREAD);
    await flush();

    expect(api.sent).toHaveLength(2);
  });

  test("a thinking card with the same eventId is posted once", async () => {
    const event: TailEvent = {
      type: "thinking",
      content: "planning the change",
      eventId: "uuid-2:0",
    };
    renderThinking(api.api, stateA(), event, THREAD);
    renderThinking(api.api, stateB(), event, THREAD);
    await flush();

    expect(api.sent).toHaveLength(1);
  });

  test("a text segment's opening bubble is created once across two tailers", async () => {
    const event: TailEvent = {
      type: "text",
      content: "Patterns are clear. Creating the branch.",
      eventId: "uuid-3:0",
    };
    renderText(api.api, stateA(), event, THREAD);
    renderText(api.api, stateB(), event, THREAD);
    await flush();

    expect(api.sent).toHaveLength(1);
  });

  test("no eventId (older/undefined) → dedup inert, both post (no regression)", async () => {
    const event: TailEvent = {
      type: "tool",
      content: "📖 Reading a.ts",
      toolName: "Read",
      toolInput: { file_path: "/a.ts" },
      toolUseId: "toolu_x",
      eventId: undefined,
    };
    renderTool(api.api, stateA(), event, THREAD);
    renderTool(api.api, stateB(), event, THREAD);
    await flush();

    expect(api.sent).toHaveLength(2);
  });
});
