// src/__tests__/cursor-cdp.test.ts
import { describe, it, expect, mock } from "bun:test";
import { CdpClient, type WebSocketLike } from "../cursor/cdp-client";

class MockWs implements WebSocketLike {
  onopen: ((this: WebSocketLike) => void) | null = null;
  onmessage: ((this: WebSocketLike, event: { data: string }) => void) | null =
    null;
  onclose: ((this: WebSocketLike) => void) | null = null;
  onerror: ((this: WebSocketLike, error: unknown) => void) | null = null;
  sent: string[] = [];
  readyState = 1;

  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.call(this);
  }
  simulateMessage(obj: unknown) {
    this.onmessage?.call(this, { data: JSON.stringify(obj) });
  }
}

describe("CdpClient", () => {
  it("sends a command and resolves with the result", async () => {
    const ws = new MockWs();
    const client = new CdpClient(ws);
    const promise = client.sendCommand("Runtime.evaluate", {
      expression: "1+1",
    });

    const msg = JSON.parse(ws.sent[0]!);
    expect(msg.method).toBe("Runtime.evaluate");
    expect(msg.params.expression).toBe("1+1");

    ws.simulateMessage({ id: msg.id, result: { result: { value: 2 } } });
    const result = await promise;
    expect(result).toEqual({ result: { value: 2 } });
  });

  it("rejects when CDP returns an error", async () => {
    const ws = new MockWs();
    const client = new CdpClient(ws);
    const promise = client.sendCommand("Runtime.evaluate", {
      expression: "bad",
    });

    const msg = JSON.parse(ws.sent[0]!);
    ws.simulateMessage({ id: msg.id, error: { message: "SyntaxError" } });
    await expect(promise).rejects.toThrow("SyntaxError");
  });

  it("dispatches notifications to registered handler", () => {
    const ws = new MockWs();
    const client = new CdpClient(ws);
    const handler = mock(() => {});
    client.onNotification("Runtime.bindingCalled", handler);

    ws.simulateMessage({
      method: "Runtime.bindingCalled",
      params: { name: "cursorBridgeMsg", payload: "hello" },
    });

    expect(handler).toHaveBeenCalledWith({
      name: "cursorBridgeMsg",
      payload: "hello",
    });
  });

  it("does not dispatch notifications to wrong handler", () => {
    const ws = new MockWs();
    const client = new CdpClient(ws);
    const handler = mock(() => {});
    client.onNotification("Page.loadEventFired", handler);

    ws.simulateMessage({
      method: "Runtime.bindingCalled",
      params: { name: "cursorBridgeMsg", payload: "hello" },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("close() disconnects", () => {
    const ws = new MockWs();
    const client = new CdpClient(ws);
    client.close();
    expect(ws.readyState).toBe(3);
  });

  it("rejects pending commands when WebSocket closes", async () => {
    const ws = new MockWs();
    const client = new CdpClient(ws);
    const promise = client.sendCommand("Runtime.evaluate", {
      expression: "slow",
    });

    // Close before response arrives
    ws.close();
    await expect(promise).rejects.toThrow("WebSocket closed");
  });
});
