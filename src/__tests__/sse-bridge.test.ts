import "./ensure-test-env";
import { describe, test, expect, beforeEach } from "bun:test";
import type { TailEvent } from "../sessions/tailer";
import type { SseEvent } from "../web/sse";
import { bridgeTailToSse } from "../handlers/watch";

describe("bridgeTailToSse", () => {
  let emitted: Array<{ sessionId: string; event: SseEvent }>;
  const bus = {
    emit(sessionId: string, event: SseEvent) {
      emitted.push({ sessionId, event });
    },
  };
  const SID = "sess-1";

  beforeEach(() => {
    emitted = [];
  });

  test("skips events whose originChat is web (already delivered optimistically)", () => {
    const e: TailEvent = { type: "text", content: "x", originChat: "web" };
    bridgeTailToSse(bus, SID, e);
    expect(emitted).toEqual([]);
  });

  test("user event → text SseEvent with › prefix", () => {
    const e: TailEvent = {
      type: "user",
      content: "hello",
      originChat: "-1003968796171",
    };
    bridgeTailToSse(bus, SID, e);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toMatchObject({
      type: "text",
      content: "› hello",
    });
  });

  test("text event passes through", () => {
    bridgeTailToSse(bus, SID, { type: "text", content: "from claude" });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toMatchObject({
      type: "text",
      content: "from claude",
    });
  });

  test("tool event carries toolName and toolInput", () => {
    bridgeTailToSse(bus, SID, {
      type: "tool",
      content: "Read(/x)",
      toolName: "Read",
      toolInput: { file_path: "/x" },
    });
    expect(emitted[0]!.event).toMatchObject({
      type: "tool",
      content: "Read(/x)",
      toolName: "Read",
      toolInput: { file_path: "/x" },
    });
  });

  test("thinking passes through", () => {
    bridgeTailToSse(bus, SID, { type: "thinking", content: "pondering…" });
    expect(emitted[0]!.event.type).toBe("thinking");
  });

  test("relay_reply maps to text", () => {
    bridgeTailToSse(bus, SID, {
      type: "relay_reply",
      content: "answer",
      originChat: "-1003968796171",
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toMatchObject({
      type: "text",
      content: "answer",
    });
  });

  test("turn_boundary is dropped (web has no display-reset concept)", () => {
    bridgeTailToSse(bus, SID, { type: "turn_boundary", content: "" });
    expect(emitted).toEqual([]);
  });
});
