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

  test("user event is NOT emitted (handleTailEvent owns user_message)", () => {
    // bridgeTailToSse used to emit text+'› ' for every user event,
    // which produced a duplicate 'You' pane in the Web UI on top of
    // the source-labelled remote pane that handleTailEvent emits.
    // It now no-ops for user events.
    const e: TailEvent = {
      type: "user",
      content: "hello",
      originChat: "-1003968796171",
    };
    bridgeTailToSse(bus, SID, e);
    expect(emitted).toHaveLength(0);
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

  test("tool_result event maps to SseEvent with toolUseId and isError", () => {
    const e: TailEvent = {
      type: "tool_result",
      content: "exit 0",
      toolUseId: "tu_1",
      isError: false,
    };
    bridgeTailToSse(bus, SID, e);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toMatchObject({
      type: "tool_result",
      content: "exit 0",
      toolUseId: "tu_1",
      isError: false,
    });
  });

  test("permission_mode event maps to SseEvent with permissionMode", () => {
    const e: TailEvent = {
      type: "permission_mode",
      content: "plan",
      permissionMode: "plan",
    };
    bridgeTailToSse(bus, SID, e);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toMatchObject({
      type: "permission_mode",
      permissionMode: "plan",
    });
  });

  test("hook_summary event maps to SseEvent with hook payload", () => {
    const e: TailEvent = {
      type: "hook_summary",
      content: "lint failed",
      hook: {
        hookCount: 1,
        errorCount: 1,
        preventedContinuation: true,
        firstError: "lint failed",
        failingHookName: "lint",
      },
    };
    bridgeTailToSse(bus, SID, e);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toMatchObject({
      type: "hook_summary",
      content: "lint failed",
      hook: {
        errorCount: 1,
        preventedContinuation: true,
        failingHookName: "lint",
      },
    });
  });
});
