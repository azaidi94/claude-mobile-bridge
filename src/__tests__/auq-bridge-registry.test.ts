import "./ensure-test-env";
import { describe, test, expect, beforeEach } from "bun:test";

describe("AuqBridgeRegistry", () => {
  beforeEach(async () => {
    const { _resetForTests } = await import("../handlers/auq-bridge-registry");
    _resetForTests();
  });

  test("register returns the same bridge state on get", async () => {
    const { register, get } = await import("../handlers/auq-bridge-registry");
    const b = register({
      requestId: "auq_1",
      toolUseId: "toolu_x",
      sessionName: "s",
      chatId: 100,
      threadId: 42,
      questions: [
        { question: "Q1", options: [{ label: "A" }, { label: "B" }] },
      ],
    });
    expect(get("auq_1")).toBe(b);
    expect(b.answers).toEqual([]);
  });

  test("resolve marks the bridge answered + invokes waiter", async () => {
    const { register, resolve, waitFor } =
      await import("../handlers/auq-bridge-registry");
    register({
      requestId: "auq_2",
      toolUseId: "toolu_y",
      sessionName: "s",
      chatId: 100,
      threadId: 42,
      questions: [
        { question: "Q1", options: [{ label: "A" }, { label: "B" }] },
      ],
    });
    const p = waitFor("auq_2", 1000);
    resolve("auq_2", {
      status: "answered",
      answers: [{ question: "Q1", answer: "A" }],
    });
    const result = await p;
    expect(result).toEqual({
      status: "answered",
      answers: [{ question: "Q1", answer: "A" }],
    });
  });

  test("waitFor resolves to cancelled when resolve is called with cancelled", async () => {
    const { register, resolve, waitFor } =
      await import("../handlers/auq-bridge-registry");
    register({
      requestId: "auq_3",
      toolUseId: "toolu_z",
      sessionName: "s",
      chatId: 100,
      threadId: 42,
      questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }],
    });
    const p = waitFor("auq_3", 1000);
    resolve("auq_3", { status: "cancelled", reason: "answered_locally" });
    expect(await p).toEqual({
      status: "cancelled",
      reason: "answered_locally",
    });
  });

  test("waitFor times out", async () => {
    const { register, waitFor } =
      await import("../handlers/auq-bridge-registry");
    register({
      requestId: "auq_4",
      toolUseId: "toolu_w",
      sessionName: "s",
      chatId: 100,
      threadId: 42,
      questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(await waitFor("auq_4", 50)).toEqual({ status: "timeout" });
  });

  test("delete removes the entry", async () => {
    const { register, get, deleteEntry } =
      await import("../handlers/auq-bridge-registry");
    register({
      requestId: "auq_5",
      toolUseId: "t",
      sessionName: "s",
      chatId: 1,
      threadId: 2,
      questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(get("auq_5")).toBeDefined();
    deleteEntry("auq_5");
    expect(get("auq_5")).toBeUndefined();
  });
});
