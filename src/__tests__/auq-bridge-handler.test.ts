import "./ensure-test-env";
import { describe, test, expect, beforeEach, mock } from "bun:test";

describe("auq-bridge orchestrator: single-question", () => {
  beforeEach(async () => {
    const { _resetForTests } = await import("../handlers/auq-bridge-registry");
    _resetForTests();
  });

  test("posts one TG card, emits SSE, resolves on TG answer", async () => {
    const { register } = await import("../handlers/auq-bridge-registry");
    const { runBridge, _injectTgAnswer } =
      await import("../handlers/auq-bridge");

    const tgCalls: Array<{
      chatId: number;
      threadId: number;
      question: string;
    }> = [];
    const sseCalls: Array<{ sessionName: string; askId: string }> = [];

    const state = register({
      requestId: "auq_1",
      toolUseId: "toolu_x",
      sessionName: "s",
      chatId: 100,
      threadId: 42,
      questions: [
        { question: "Pick", options: [{ label: "A" }, { label: "B" }] },
      ],
    });

    const promise = runBridge(state, {
      postTg: async (args) => {
        tgCalls.push(args);
        return { messageId: 999 };
      },
      emitSse: (ev) => sseCalls.push({ sessionName: "s", askId: ev.askId! }),
      clearedSse: () => {},
    });

    // Simulate TG button tap arriving via the dispatcher
    _injectTgAnswer("auq_1", 0, "A");

    const r = await promise;
    expect(r.status).toBe("answered");
    if (r.status === "answered") {
      expect(r.answers).toEqual([{ question: "Pick", answer: "A" }]);
    }
    expect(tgCalls).toHaveLength(1);
    expect(tgCalls[0]!.question).toBe("Pick");
    expect(sseCalls).toHaveLength(1);
  });

  test("postTg throwing resolves the registry as cancelled and rethrows", async () => {
    const { register, get } = await import("../handlers/auq-bridge-registry");
    const { runBridge } = await import("../handlers/auq-bridge");

    const state = register({
      requestId: "auq_err",
      toolUseId: "toolu_e",
      sessionName: "s",
      chatId: 100,
      threadId: 42,
      questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }],
    });

    await expect(
      runBridge(state, {
        postTg: async () => {
          throw new Error("tg auth revoked");
        },
        emitSse: () => {},
        clearedSse: () => {},
      }),
    ).rejects.toThrow("tg auth revoked");

    const bridge = get("auq_err")!;
    expect(bridge.resolution?.status).toBe("cancelled");
    if (bridge.resolution?.status === "cancelled") {
      expect(bridge.resolution.reason).toContain("tg auth revoked");
    }
  });

  test("loops 3 questions sequentially, returns answers in order", async () => {
    const { register } = await import("../handlers/auq-bridge-registry");
    const { runBridge, _injectTgAnswer } =
      await import("../handlers/auq-bridge");

    const tgCalls: string[] = [];
    const state = register({
      requestId: "auq_m",
      toolUseId: "toolu_m",
      sessionName: "s",
      chatId: 100,
      threadId: 42,
      questions: [
        { question: "Q1", options: [{ label: "A" }, { label: "B" }] },
        { question: "Q2", options: [{ label: "X" }, { label: "Y" }] },
        { question: "Q3", options: [{ label: "P" }, { label: "Q" }] },
      ],
    });

    const promise = runBridge(state, {
      postTg: async (args) => {
        tgCalls.push(args.question);
        // Answer the question we just posted, in order, on the next tick.
        const qi = tgCalls.length - 1;
        const answer = ["A", "Y", "Q"][qi]!;
        setTimeout(() => _injectTgAnswer("auq_m", qi, answer), 0);
        return { messageId: 1000 + qi };
      },
      emitSse: () => {},
      clearedSse: () => {},
    });

    const r = await promise;
    expect(r.status).toBe("answered");
    if (r.status === "answered") {
      expect(r.answers).toEqual([
        { question: "Q1", answer: "A" },
        { question: "Q2", answer: "Y" },
        { question: "Q3", answer: "Q" },
      ]);
    }
    expect(tgCalls).toEqual(["Q1", "Q2", "Q3"]);
  });

  test("cancels bridge when tool_result for matching tool_use_id arrives on bus", async () => {
    const { register } = await import("../handlers/auq-bridge-registry");
    const { runBridge, attachBusCancellation } =
      await import("../handlers/auq-bridge");
    const { SessionEventBus } = await import("../web/sse");
    const bus = new SessionEventBus();
    const clearedCalls: Array<{ askId: string; resolution: string }> = [];

    const state = register({
      requestId: "auq_c",
      toolUseId: "toolu_cancel",
      sessionName: "s-cancel",
      chatId: 100,
      threadId: 42,
      questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }],
    });

    attachBusCancellation(state, bus);

    const promise = runBridge(state, {
      postTg: async () => ({ messageId: 999 }),
      emitSse: () => {},
      clearedSse: (askId, resolution) =>
        clearedCalls.push({ askId, resolution }),
    });

    // Simulate the JSONL tailer emitting tool_result for our tool_use_id.
    bus.emit("s-cancel", {
      type: "tool_result",
      content: "ok",
      toolUseId: "toolu_cancel",
    });

    const r = await promise;
    expect(r.status).toBe("cancelled");
    if (r.status === "cancelled") expect(r.reason).toBe("answered_locally");
    expect(clearedCalls.some((c) => c.resolution === "cancelled")).toBe(true);
  });

  test("getOpenAsksForSession reflects open asks and clears them on resolution", async () => {
    const { register, _resetForTests } =
      await import("../handlers/auq-bridge-registry");
    const {
      runBridge,
      _injectTgAnswer,
      getOpenAsksForSession,
      _resetOpenAsksForTests,
    } = await import("../handlers/auq-bridge");
    _resetForTests();
    _resetOpenAsksForTests();

    const state = register({
      requestId: "auq_snap",
      toolUseId: "toolu_snap",
      sessionName: "s-snap",
      chatId: 100,
      threadId: 42,
      questions: [
        { question: "Pick", options: [{ label: "A" }, { label: "B" }] },
      ],
    });

    let observedDuring: ReturnType<typeof getOpenAsksForSession> = [];
    const promise = runBridge(state, {
      postTg: async () => ({ messageId: 1 }),
      emitSse: () => {
        // While the ask is in flight, server should report it as open.
        observedDuring = getOpenAsksForSession("s-snap");
      },
      clearedSse: () => {},
    });

    _injectTgAnswer("auq_snap", 0, "A");
    await promise;

    expect(observedDuring).toHaveLength(1);
    expect(observedDuring[0]!.askId).toBe("bridge:auq_snap:0");
    expect(observedDuring[0]!.question).toBe("Pick");
    // After resolution the snapshot should be empty.
    expect(getOpenAsksForSession("s-snap")).toEqual([]);
  });

  test("attachBusCancellation returns an unsub that detaches the listener", async () => {
    const { register } = await import("../handlers/auq-bridge-registry");
    const { attachBusCancellation } = await import("../handlers/auq-bridge");
    const { SessionEventBus } = await import("../web/sse");

    const bus = new SessionEventBus();
    const state = register({
      requestId: "auq_unsub",
      toolUseId: "toolu_unsub",
      sessionName: "s-unsub",
      chatId: 100,
      threadId: 42,
      questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }],
    });

    const unsub = attachBusCancellation(state, bus);
    unsub();

    // After unsub, a matching tool_result should NOT mark the bridge cancelled.
    bus.emit("s-unsub", {
      type: "tool_result",
      content: "ok",
      toolUseId: "toolu_unsub",
    });

    // Give any microtasks a moment to flush
    await new Promise((r) => setTimeout(r, 5));

    const { get } = await import("../handlers/auq-bridge-registry");
    expect(get("auq_unsub")?.resolution).toBeNull();
  });
});
