/**
 * Echo-suppression matrix for the Cursor bridge.
 *
 * When TG/Web sends a user_message via the bus, the bridge injects it
 * into Cursor's Composer. Cursor renders it; the observer fires
 * HUMAN_BINDING with what came back from Cursor's DOM, which can
 * differ from the original via Lexical auto-correct (em-dashes,
 * smart quotes), case shifts, and multi-panel re-renders. The bridge
 * must drop those echoes — otherwise the user sees their own message
 * twice (once optimistically, once as "🖱 Cursor: ..." cross-post).
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { CursorBridge } from "../cursor/bridge";
import { SessionEventBus, type SseEvent } from "../web/sse";

interface MockNotificationHandler {
  method: string;
  handler: (params: Record<string, unknown>) => void;
}

function makeMockCdp() {
  const notificationHandlers: MockNotificationHandler[] = [];
  return {
    sendCommand: mock(async (method: string) => {
      if (method === "Runtime.evaluate") {
        return { result: { type: "object", value: [] as string[] } };
      }
      return {};
    }),
    onNotification: mock(
      (method: string, handler: (params: Record<string, unknown>) => void) => {
        notificationHandlers.push({ method, handler });
        return () => {};
      },
    ),
    close: mock(() => {}),
    simulateBinding: (name: string, payload: string) => {
      for (const { method, handler } of notificationHandlers) {
        if (method === "Runtime.bindingCalled") handler({ name, payload });
      }
    },
  };
}

const SESSION = "cursor-test";

async function setup() {
  const bus = new SessionEventBus();
  const cdp = makeMockCdp();
  const received: SseEvent[] = [];
  bus.subscribe(SESSION, (e) => received.push(e));
  const bridge = new CursorBridge({
    sessionName: SESSION,
    sessionDir: "/tmp",
    cdpClient: cdp as never,
    bus,
  });
  await bridge.start();
  received.length = 0;
  return { bus, cdp, bridge, received };
}

function emitUser(bus: SessionEventBus, content: string, source = "telegram") {
  bus.emit(SESSION, {
    type: "user_message",
    source: source as "telegram" | "web",
    content,
  });
}

function userEmits(received: SseEvent[]) {
  return received.filter(
    (e) => e.type === "user_message" && e.source === "cursor",
  );
}

describe("CursorBridge echo suppression", () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
  });

  it("drops a HUMAN_BINDING fire that exactly matches a recent injection", () => {
    emitUser(env.bus, "Hello world");
    env.cdp.simulateBinding("cursorBridgeHumanMsg", "Hello world");
    expect(userEmits(env.received)).toHaveLength(0);
  });

  it("drops an echo with an em-dash where we sent a hyphen", () => {
    emitUser(env.bus, "foo - bar");
    // Lexical auto-correct: hyphen → em-dash
    env.cdp.simulateBinding("cursorBridgeHumanMsg", "foo — bar");
    expect(userEmits(env.received)).toHaveLength(0);
  });

  it("drops an echo with smart quotes where we sent straight quotes", () => {
    emitUser(env.bus, `it's a "test"`);
    env.cdp.simulateBinding("cursorBridgeHumanMsg", "it’s a “test”");
    expect(userEmits(env.received)).toHaveLength(0);
  });

  it("drops an echo with case shifts (Cursor auto-cap)", () => {
    emitUser(env.bus, "the build passed");
    env.cdp.simulateBinding("cursorBridgeHumanMsg", "The build passed");
    expect(userEmits(env.received)).toHaveLength(0);
  });

  it("drops MULTIPLE HUMAN_BINDING fires for the same injected text", () => {
    emitUser(env.bus, "Same message");
    env.cdp.simulateBinding("cursorBridgeHumanMsg", "Same message");
    env.cdp.simulateBinding("cursorBridgeHumanMsg", "Same message");
    env.cdp.simulateBinding("cursorBridgeHumanMsg", "Same message");
    expect(userEmits(env.received)).toHaveLength(0);
  });

  it("drops an ellipsis-variant echo", () => {
    emitUser(env.bus, "wait...");
    env.cdp.simulateBinding("cursorBridgeHumanMsg", "wait…");
    expect(userEmits(env.received)).toHaveLength(0);
  });

  it("drops an echo with collapsed whitespace", () => {
    emitUser(env.bus, "hello   world");
    env.cdp.simulateBinding("cursorBridgeHumanMsg", "hello world");
    expect(userEmits(env.received)).toHaveLength(0);
  });

  it("LETS THROUGH a genuine native cursor input that wasn't injected", () => {
    // No bus emit first — user typed directly in Composer.
    env.cdp.simulateBinding("cursorBridgeHumanMsg", "I typed this in Cursor");
    expect(userEmits(env.received)).toHaveLength(1);
    expect(userEmits(env.received)[0]!.content).toBe("I typed this in Cursor");
  });

  it("LETS THROUGH a different message that wasn't recently injected", () => {
    emitUser(env.bus, "First message");
    env.cdp.simulateBinding("cursorBridgeHumanMsg", "First message");
    // Different content — should NOT be suppressed.
    env.cdp.simulateBinding("cursorBridgeHumanMsg", "Different content here");
    expect(userEmits(env.received)).toHaveLength(1);
    expect(userEmits(env.received)[0]!.content).toBe("Different content here");
  });

  it("emits source: cursor when a native fire is forwarded", () => {
    env.cdp.simulateBinding("cursorBridgeHumanMsg", "native");
    const emits = userEmits(env.received);
    expect(emits[0]).toMatchObject({
      type: "user_message",
      source: "cursor",
      content: "native",
    });
  });
});
