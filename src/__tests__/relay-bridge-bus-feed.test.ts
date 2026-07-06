import "./ensure-test-env";
import { describe, test, expect, beforeEach } from "bun:test";
import type { Api } from "grammy";
import type { TailEvent } from "../sessions/tailer";
import { makeRelayTailHandler } from "../handlers/relay-bridge";
import { createRelayDisplayState } from "../relay";
import { attachBusCancellation } from "../handlers/auq-bridge";
import { register, get, _resetForTests } from "../handlers/auq-bridge-registry";
import { createMessageBus, setMessageBus } from "../messaging";

// Any Api method call resolves harmlessly — we only care about the bus path.
const fakeApi = new Proxy(
  {},
  {
    get() {
      return () => Promise.resolve({ message_id: 1 });
    },
  },
) as unknown as Api;

describe("relay tailer feeds the bridge-cancellation bus", () => {
  beforeEach(() => {
    _resetForTests();
    // handleTailEvent renders via the MessageBus; wire a harmless one so the
    // real (finalReplyReceived === false) path runs without throwing.
    setMessageBus(createMessageBus(fakeApi));
  });

  // Regression: in pure relay mode (no active /watch) the JSONL tailer used to
  // call only handleTailEvent, never bridgeTailToSse, so attachBusCancellation
  // never saw the local terminal tool_result and the TG AUQ card stayed blocked
  // even though the session continued at the desktop.
  test("a local tool_result for a pending AUQ cancels the bridge in relay mode", () => {
    const sessionName = "proj-main";
    const toolUseId = "toolu_abc";

    register({
      requestId: "req-1",
      toolUseId,
      sessionName,
      chatId: 1,
      threadId: 2,
      questions: [{ question: "Pick", options: [{ label: "A" }] }],
    });
    const unsub = attachBusCancellation({
      requestId: "req-1",
      toolUseId,
      sessionName,
    });

    const state = createRelayDisplayState(1, 2);
    const handler = makeRelayTailHandler(fakeApi, state, sessionName);

    const event: TailEvent = {
      type: "tool_result",
      content: "A",
      toolUseId,
      isError: false,
    };
    handler(event);

    expect(get("req-1")?.resolution).toEqual({
      status: "cancelled",
      reason: "answered_locally",
    });
    unsub();
  });

  test("does nothing for a tool_result that targets a different session", () => {
    const toolUseId = "toolu_xyz";
    register({
      requestId: "req-2",
      toolUseId,
      sessionName: "proj-main",
      chatId: 1,
      threadId: 2,
      questions: [{ question: "Pick", options: [{ label: "A" }] }],
    });
    const unsub = attachBusCancellation({
      requestId: "req-2",
      toolUseId,
      sessionName: "proj-main",
    });

    const state = createRelayDisplayState(1, 2);
    // Handler wired for a DIFFERENT session — its emit must not reach req-2.
    const handler = makeRelayTailHandler(fakeApi, state, "other-session");
    handler({ type: "tool_result", content: "A", toolUseId, isError: false });

    expect(get("req-2")?.resolution).toBeNull();
    unsub();
  });
});
