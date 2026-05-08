// src/__tests__/cursor-bridge.test.ts
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { CursorBridge } from "../cursor/bridge";
import { SessionEventBus } from "../web/sse";

interface MockNotificationHandler {
  method: string;
  handler: (params: Record<string, unknown>) => void;
}

function makeMockCdp() {
  const notificationHandlers: MockNotificationHandler[] = [];
  const commandLog: Array<{ method: string; params: Record<string, unknown> }> =
    [];

  return {
    sendCommand: mock(
      async (method: string, params: Record<string, unknown> = {}) => {
        commandLog.push({ method, params });
        if (method === "Runtime.evaluate") {
          // Return empty snapshot
          return { result: { type: "object", value: [] as string[] } };
        }
        return {};
      },
    ),
    onNotification: mock(
      (method: string, handler: (params: Record<string, unknown>) => void) => {
        notificationHandlers.push({ method, handler });
        return () => {};
      },
    ),
    close: mock(() => {}),
    commandLog,
    // Test helper: simulate a binding called notification
    simulateBinding: (name: string, payload: string) => {
      for (const { method, handler } of notificationHandlers) {
        if (method === "Runtime.bindingCalled") {
          handler({ name, payload });
        }
      }
    },
  };
}

describe("CursorBridge", () => {
  let bus: SessionEventBus;
  let cdp: ReturnType<typeof makeMockCdp>;

  beforeEach(() => {
    bus = new SessionEventBus();
    cdp = makeMockCdp();
  });

  it("calls Runtime.enable and Runtime.addBinding on start", async () => {
    const bridge = new CursorBridge({
      sessionName: "cursor-ws",
      sessionDir: "/tmp/proj",
      cdpClient: cdp as never,
      bus,
    });
    await bridge.start();
    bridge.stop();

    const methods = cdp.commandLog.map((c) => c.method);
    expect(methods).toContain("Runtime.enable");
    expect(methods).toContain("Runtime.addBinding");
  });

  it("publishes user_message to bus when binding is called", async () => {
    const received: unknown[] = [];
    bus.subscribe("cursor-ws", (e) => received.push(e));

    const bridge = new CursorBridge({
      sessionName: "cursor-ws",
      sessionDir: "/tmp/proj",
      cdpClient: cdp as never,
      bus,
    });
    await bridge.start();
    cdp.simulateBinding("cursorBridgeHumanMsg", "Hello from Cursor");
    bridge.stop();

    expect(received).toContainEqual(
      expect.objectContaining({
        type: "user_message",
        source: "cursor",
        content: "Hello from Cursor",
      }),
    );
  });

  it("does not publish messages from the initial snapshot", async () => {
    // Simulate non-empty snapshot
    cdp.sendCommand = mock(
      async (method: string, _params: Record<string, unknown> = {}) => {
        if (method === "Runtime.evaluate") {
          return { result: { type: "object", value: ["Old history message"] } };
        }
        return {};
      },
    );

    const received: unknown[] = [];
    bus.subscribe("cursor-ws", (e) => received.push(e));

    const bridge = new CursorBridge({
      sessionName: "cursor-ws",
      sessionDir: "/tmp/proj",
      cdpClient: cdp as never,
      bus,
    });
    await bridge.start();
    // Simulate binding called for the same message that was in the snapshot
    cdp.simulateBinding("cursorBridgeHumanMsg", "Old history message");
    bridge.stop();

    expect(received).toHaveLength(0);
  });

  it("injects bus messages from non-cursor sources into Composer", async () => {
    const bridge = new CursorBridge({
      sessionName: "cursor-ws",
      sessionDir: "/tmp/proj",
      cdpClient: cdp as never,
      bus,
    });
    await bridge.start();

    bus.emit("cursor-ws", {
      type: "user_message",
      source: "telegram",
      content: "Hello from Telegram",
    });

    await new Promise((r) => setTimeout(r, 10));
    bridge.stop();

    const injectCalls = cdp.commandLog.filter(
      (c) =>
        c.method === "Runtime.evaluate" &&
        String((c.params as { expression?: string }).expression ?? "").includes(
          "Hello from Telegram",
        ),
    );
    expect(injectCalls.length).toBeGreaterThan(0);
  });

  it("does not inject cursor-sourced messages (prevents echo)", async () => {
    const bridge = new CursorBridge({
      sessionName: "cursor-ws",
      sessionDir: "/tmp/proj",
      cdpClient: cdp as never,
      bus,
    });
    await bridge.start();

    bus.emit("cursor-ws", {
      type: "user_message",
      source: "cursor",
      content: "My own message",
    });

    await new Promise((r) => setTimeout(r, 10));
    bridge.stop();

    // Verify NO inject script was evaluated containing the cursor-
    // source message body. The previous version of this test searched
    // for 'nativeInputValueSetter' in command expressions; that string
    // was removed when buildInjectScript switched to ClipboardEvent,
    // so the assertion was trivially true regardless of the bug.
    const injectCalls = cdp.commandLog.filter(
      (c) =>
        c.method === "Runtime.evaluate" &&
        String((c.params as { expression?: string }).expression ?? "").includes(
          "My own message",
        ),
    );
    expect(injectCalls.length).toBe(0);
  });
});
