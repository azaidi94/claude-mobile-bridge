/**
 * Unit tests for RelayClient callback scoping and cleanup.
 */

import { describe, expect, test } from "bun:test";

async function loadRelayClient() {
  process.env.TELEGRAM_BOT_TOKEN ||= "test";
  process.env.TELEGRAM_ALLOWED_USERS ||= "1";
  return import("../relay/client");
}

describe("relay client: scoped callbacks", () => {
  test("reply callbacks only fire for matching chat ids", async () => {
    const { RelayClient } = await loadRelayClient();
    const client = new RelayClient();
    const seen: string[] = [];

    client.onReply((msg) => {
      seen.push(`global:${msg.chat_id}:${msg.text}`);
    });
    client.onReply((msg) => {
      seen.push(`chat-1:${msg.chat_id}:${msg.text}`);
    }, "1");
    client.onReply((msg) => {
      seen.push(`chat-2:${msg.chat_id}:${msg.text}`);
    }, "2");

    (client as any).handleMessage({ type: "reply", chat_id: "1", text: "one" });
    (client as any).handleMessage({ type: "reply", chat_id: "2", text: "two" });

    expect(seen).toEqual([
      "global:1:one",
      "chat-1:1:one",
      "global:2:two",
      "chat-2:2:two",
    ]);
  });
});

describe("relay client: disconnect cleanup", () => {
  test("offDisconnect removes a registered disconnect callback", async () => {
    const { RelayClient } = await loadRelayClient();
    const client = new RelayClient();
    let disconnects = 0;

    const onDisconnect = () => {
      disconnects += 1;
    };

    client.onDisconnect(onDisconnect);
    client.offDisconnect(onDisconnect);

    for (const cb of (client as any).disconnectCallbacks) {
      cb();
    }

    expect(disconnects).toBe(0);
  });
});
