import { describe, test, expect } from "bun:test";

async function loadSse() {
  process.env.TELEGRAM_BOT_TOKEN ||= "test";
  process.env.TELEGRAM_ALLOWED_USERS ||= "1";
  return import("../web/sse");
}

describe("SessionEventBus", () => {
  test("emit delivers event to subscriber", async () => {
    const { SessionEventBus } = await loadSse();
    const bus = new SessionEventBus();
    const received: Array<{ type: string; content: string }> = [];

    const unsub = bus.subscribe("session-1", (evt) => received.push(evt));
    bus.emit("session-1", { type: "text", content: "hello" });
    unsub();
    bus.emit("session-1", { type: "text", content: "ignored" });

    expect(received).toEqual([{ type: "text", content: "hello" }]);
  });

  test("subscriber only receives events for its session", async () => {
    const { SessionEventBus } = await loadSse();
    const bus = new SessionEventBus();
    const received: string[] = [];

    bus.subscribe("session-a", (evt) => received.push(`a:${evt.content}`));
    bus.emit("session-a", { type: "text", content: "for-a" });
    bus.emit("session-b", { type: "text", content: "for-b" });

    expect(received).toEqual(["a:for-a"]);
  });

  test("makeStatusCallback emits events to bus", async () => {
    const { SessionEventBus } = await loadSse();
    const bus = new SessionEventBus();
    const received: Array<{ type: string; content: string }> = [];

    bus.subscribe("s1", (evt) => received.push(evt));
    const cb = bus.makeStatusCallback("s1");
    await cb("text", "some output");
    await cb("tool", "Read file");

    expect(received).toEqual([
      { type: "text", content: "some output" },
      { type: "tool", content: "Read file" },
    ]);
  });
});
