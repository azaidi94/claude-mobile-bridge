/**
 * relay-ask round-trip tests.
 *
 * Covers:
 *   1. ask_remote_request → bot posts an inline keyboard
 *   2. Button tap → answer routes back via sendAskRemoteAnswer
 *   3. Custom-text path: tap "Type a custom answer" then send text → answer
 *   4. Cancel button → error sent back
 *   5. Stale callback (ask_id no longer pending) is rejected
 */

import "./ensure-test-env";
import { describe, expect, test, beforeEach, mock } from "bun:test";
import {
  initRelayAsk,
  attachAskRemoteToRelay,
  handleAskRemoteCallback,
  tryConsumeCustomTextAnswer,
  submitAnswerFromWeb,
  cancelAnswerFromWeb,
  _resetForTests,
  _pendingCountForTests,
} from "../handlers/relay-ask";
import type { RelayAskRemoteRequest, RelayClient } from "../relay/client";
import { globalEventBus, type SseEvent } from "../web/sse";

interface SentMessage {
  chatId: number | string;
  text: string;
  opts?: Record<string, unknown>;
}

function makeMockApi() {
  const sent: SentMessage[] = [];
  const edits: Array<{
    chatId: number | string;
    messageId: number;
    text: string;
  }> = [];
  const callbackAcks: Array<{ id: string; text?: string }> = [];

  const api = {
    sendMessage: async (
      chatId: number | string,
      text: string,
      opts?: Record<string, unknown>,
    ) => {
      sent.push({ chatId, text, opts });
      return { message_id: sent.length };
    },
    editMessageText: async (
      chatId: number | string,
      messageId: number,
      text: string,
    ) => {
      edits.push({ chatId, messageId, text });
      return true;
    },
    answerCallbackQuery: async (id: string, opts?: { text?: string }) => {
      callbackAcks.push({ id, text: opts?.text });
      return true;
    },
  } as unknown as import("grammy").Api;

  return { api, sent, edits, callbackAcks };
}

function makeMockClient(sessionName?: string) {
  const askRemoteHandlers: Array<(r: RelayAskRemoteRequest) => void> = [];
  const sentAnswers: Array<{
    ask_id: string;
    answer?: string;
    error?: string;
  }> = [];
  const client = {
    sessionName,
    onAskRemoteRequest: (cb: (r: RelayAskRemoteRequest) => void) => {
      askRemoteHandlers.push(cb);
    },
    sendAskRemoteAnswer: mock(
      (params: { ask_id: string; answer?: string; error?: string }) => {
        sentAnswers.push(params);
        return true;
      },
    ),
  } as unknown as RelayClient;
  return {
    client,
    fireAskRemote: (req: RelayAskRemoteRequest) => {
      for (const h of askRemoteHandlers) h(req);
    },
    sentAnswers,
  };
}

function captureBusEvents(sessionName: string): {
  events: SseEvent[];
  unsubscribe: () => void;
} {
  const events: SseEvent[] = [];
  const unsubscribe = globalEventBus.subscribe(sessionName, (e) =>
    events.push(e),
  );
  return { events, unsubscribe };
}

const SAMPLE_REQ: RelayAskRemoteRequest = {
  ask_id: "a1_test",
  chat_id: "-1003968796171",
  thread_id: "33308",
  question: "Apply the patch?",
  options: [
    { label: "Yes, apply now", description: "Edits two JSON files" },
    { label: "No, skip", description: "Defer to later" },
  ],
  allow_custom: true,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("relay-ask: post + button tap round-trip", () => {
  beforeEach(() => {
    _resetForTests();
  });

  test("ask_remote_request posts an inline keyboard with one button per option + custom + cancel", async () => {
    const { api, sent } = makeMockApi();
    initRelayAsk(api);
    const { client, fireAskRemote } = makeMockClient();
    attachAskRemoteToRelay(client);

    fireAskRemote(SAMPLE_REQ);
    await sleep(0);

    expect(sent).toHaveLength(1);
    const msg = sent[0]!;
    expect(msg.chatId).toBe(-1003968796171);
    expect(msg.text).toContain("Apply the patch?");
    expect(msg.text).toContain("Yes, apply now");
    expect(msg.text).toContain("No, skip");
    expect(msg.opts?.parse_mode).toBe("HTML");
    expect(msg.opts?.message_thread_id).toBe(33308);

    const kb = (msg.opts?.reply_markup as { inline_keyboard: unknown[][] })
      .inline_keyboard;
    // 2 option rows + custom + cancel = 4
    expect(kb).toHaveLength(4);
    const customRow = kb[2] as Array<{ text: string; callback_data: string }>;
    const cancelRow = kb[3] as Array<{ text: string; callback_data: string }>;
    expect(customRow[0]!.callback_data).toBe("askremote:a1_test:custom");
    expect(cancelRow[0]!.callback_data).toBe("askremote:a1_test:cancel");

    expect(_pendingCountForTests()).toBe(1);
  });

  test("button tap sends answer back + edits message + clears pending", async () => {
    const { api, edits } = makeMockApi();
    initRelayAsk(api);
    const { client, fireAskRemote, sentAnswers } = makeMockClient();
    attachAskRemoteToRelay(client);

    fireAskRemote(SAMPLE_REQ);
    await sleep(0);

    const consumed = await handleAskRemoteCallback(
      api,
      "askremote:a1_test:0",
      "cbq-1",
      -1003968796171,
    );
    expect(consumed).toBe(true);
    expect(sentAnswers).toEqual([
      { ask_id: "a1_test", answer: "Yes, apply now" },
    ]);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toContain("✅ Yes, apply now");
    expect(_pendingCountForTests()).toBe(0);
  });

  test("custom-text path: tap custom → next message routes as answer", async () => {
    const { api, edits } = makeMockApi();
    initRelayAsk(api);
    const { client, fireAskRemote, sentAnswers } = makeMockClient();
    attachAskRemoteToRelay(client);

    fireAskRemote(SAMPLE_REQ);
    await sleep(0);

    // User taps the custom button.
    await handleAskRemoteCallback(
      api,
      "askremote:a1_test:custom",
      "cbq-1",
      -1003968796171,
    );
    // No answer yet — still pending.
    expect(sentAnswers).toHaveLength(0);
    expect(_pendingCountForTests()).toBe(1);
    expect(edits[0]!.text).toContain("Send your answer as a message");

    // User sends free-text in the same chat.
    const consumed = tryConsumeCustomTextAnswer(
      -1003968796171,
      "Apply only fixture A but skip B",
    );
    expect(consumed).toBe(true);
    expect(sentAnswers).toEqual([
      { ask_id: "a1_test", answer: "Apply only fixture A but skip B" },
    ]);
    expect(_pendingCountForTests()).toBe(0);
  });

  test("custom-text in a chat without a pending custom-await is not consumed", () => {
    expect(tryConsumeCustomTextAnswer(99999, "hello")).toBe(false);
  });

  test("cancel button sends error back + clears pending", async () => {
    const { api } = makeMockApi();
    initRelayAsk(api);
    const { client, fireAskRemote, sentAnswers } = makeMockClient();
    attachAskRemoteToRelay(client);

    fireAskRemote(SAMPLE_REQ);
    await sleep(0);

    await handleAskRemoteCallback(
      api,
      "askremote:a1_test:cancel",
      "cbq-1",
      -1003968796171,
    );
    expect(sentAnswers).toEqual([
      { ask_id: "a1_test", error: "user cancelled" },
    ]);
    expect(_pendingCountForTests()).toBe(0);
  });

  test("stale callback (ask_id not pending) is acknowledged but not routed", async () => {
    const { api } = makeMockApi();
    initRelayAsk(api);
    const { client, sentAnswers } = makeMockClient();
    attachAskRemoteToRelay(client);

    const consumed = await handleAskRemoteCallback(
      api,
      "askremote:nonexistent:0",
      "cbq-9",
      -1003968796171,
    );
    expect(consumed).toBe(true);
    expect(sentAnswers).toHaveLength(0);
  });

  test("non-askremote callback returns false (not consumed)", async () => {
    const { api } = makeMockApi();
    initRelayAsk(api);
    const consumed = await handleAskRemoteCallback(
      api,
      "set:save:terminal:Ghostty",
      "cbq-1",
      100,
    );
    expect(consumed).toBe(false);
  });

  test("invalid option index is rejected without sending answer", async () => {
    const { api } = makeMockApi();
    initRelayAsk(api);
    const { client, fireAskRemote, sentAnswers } = makeMockClient();
    attachAskRemoteToRelay(client);

    fireAskRemote(SAMPLE_REQ);
    await sleep(0);

    await handleAskRemoteCallback(
      api,
      "askremote:a1_test:42", // out of range
      "cbq-1",
      -1003968796171,
    );
    expect(sentAnswers).toHaveLength(0);
    // Pending entry remains since we didn't resolve.
    expect(_pendingCountForTests()).toBe(1);
  });

  test("attach with no init does nothing (logs only)", () => {
    _resetForTests();
    const { client, fireAskRemote, sentAnswers } = makeMockClient();
    // No initRelayAsk called.
    attachAskRemoteToRelay(client);
    fireAskRemote(SAMPLE_REQ);
    expect(sentAnswers).toHaveLength(0);
    expect(_pendingCountForTests()).toBe(0);
  });

  test("missing thread_id falls back to no message_thread_id option", async () => {
    const { api, sent } = makeMockApi();
    initRelayAsk(api);
    const { client, fireAskRemote } = makeMockClient();
    attachAskRemoteToRelay(client);

    const noThreadReq: RelayAskRemoteRequest = {
      ...SAMPLE_REQ,
      thread_id: undefined,
    };
    fireAskRemote(noThreadReq);
    await sleep(0);

    expect(sent[0]!.opts).not.toHaveProperty("message_thread_id");
  });

  test("question delivery failure (sendMessage throws) reports back as error", async () => {
    initRelayAsk({
      sendMessage: async () => {
        throw new Error("Telegram 400: chat not found");
      },
      editMessageText: async () => true,
      answerCallbackQuery: async () => true,
    } as unknown as import("grammy").Api);

    const { client, fireAskRemote, sentAnswers } = makeMockClient();
    attachAskRemoteToRelay(client);

    fireAskRemote(SAMPLE_REQ);
    // Settle the async error path.
    await sleep(0);
    await sleep(0);

    expect(sentAnswers).toHaveLength(1);
    expect(sentAnswers[0]!.ask_id).toBe("a1_test");
    expect(sentAnswers[0]!.error).toContain("Telegram 400");
    expect(_pendingCountForTests()).toBe(0);
  });

  test("ask_remote_request emits ask_remote on the bus when client.sessionName is set", async () => {
    const { api } = makeMockApi();
    initRelayAsk(api);
    const { client, fireAskRemote } = makeMockClient("cdm-test");
    attachAskRemoteToRelay(client);
    const { events, unsubscribe } = captureBusEvents("cdm-test");

    fireAskRemote(SAMPLE_REQ);
    await sleep(0);

    const ask = events.find((e) => e.type === "ask_remote");
    expect(ask).toBeDefined();
    expect(ask!.askId).toBe("a1_test");
    expect(ask!.askQuestion).toBe("Apply the patch?");
    expect(ask!.askOptions).toHaveLength(2);
    expect(ask!.askAllowCustom).toBe(true);

    unsubscribe();
  });

  test("answer via TG button emits ask_remote_cleared on the bus (Web UI dismisses card)", async () => {
    const { api } = makeMockApi();
    initRelayAsk(api);
    const { client, fireAskRemote } = makeMockClient("cdm-test");
    attachAskRemoteToRelay(client);
    const { events, unsubscribe } = captureBusEvents("cdm-test");

    fireAskRemote(SAMPLE_REQ);
    await sleep(0);

    await handleAskRemoteCallback(
      api,
      "askremote:a1_test:0",
      "cbq-1",
      -1003968796171,
    );

    const cleared = events.find((e) => e.type === "ask_remote_cleared");
    expect(cleared).toBeDefined();
    expect(cleared!.askId).toBe("a1_test");
    expect(cleared!.askResolution).toBe("answered");
    expect(cleared!.askAnswer).toBe("Yes, apply now");

    unsubscribe();
  });

  test("submitAnswerFromWeb routes through MCP, edits TG msg, emits cleared", async () => {
    const { api, edits } = makeMockApi();
    initRelayAsk(api);
    const { client, fireAskRemote, sentAnswers } = makeMockClient("cdm-test");
    attachAskRemoteToRelay(client);
    const { events, unsubscribe } = captureBusEvents("cdm-test");

    fireAskRemote(SAMPLE_REQ);
    await sleep(0);

    const ok = submitAnswerFromWeb("a1_test", "Yes, apply now");
    expect(ok).toBe(true);
    expect(sentAnswers).toEqual([
      { ask_id: "a1_test", answer: "Yes, apply now" },
    ]);
    expect(edits.some((e) => e.text.includes("✅ Yes, apply now"))).toBe(true);

    const cleared = events.find((e) => e.type === "ask_remote_cleared");
    expect(cleared?.askResolution).toBe("answered");
    expect(_pendingCountForTests()).toBe(0);

    unsubscribe();
  });

  test("submitAnswerFromWeb returns false for unknown ask_id (already resolved)", () => {
    initRelayAsk(makeMockApi().api);
    const ok = submitAnswerFromWeb("nonexistent", "anything");
    expect(ok).toBe(false);
  });

  test("cancelAnswerFromWeb sends error to MCP + emits cancelled cleared", async () => {
    const { api } = makeMockApi();
    initRelayAsk(api);
    const { client, fireAskRemote, sentAnswers } = makeMockClient("cdm-test");
    attachAskRemoteToRelay(client);
    const { events, unsubscribe } = captureBusEvents("cdm-test");

    fireAskRemote(SAMPLE_REQ);
    await sleep(0);

    const ok = cancelAnswerFromWeb("a1_test");
    expect(ok).toBe(true);
    expect(sentAnswers).toEqual([
      { ask_id: "a1_test", error: "user cancelled (web)" },
    ]);
    const cleared = events.find((e) => e.type === "ask_remote_cleared");
    expect(cleared?.askResolution).toBe("cancelled");

    unsubscribe();
  });

  test("client without sessionName: TG works fine, bus stays silent", async () => {
    const { api } = makeMockApi();
    initRelayAsk(api);
    const { client, fireAskRemote } = makeMockClient(undefined);
    attachAskRemoteToRelay(client);
    // Subscribe under any plausible key — should never fire.
    const { events, unsubscribe } = captureBusEvents("any-key");

    fireAskRemote(SAMPLE_REQ);
    await sleep(0);

    expect(events).toHaveLength(0);
    expect(_pendingCountForTests()).toBe(1);

    unsubscribe();
  });

  test("long option labels are truncated for the button display", async () => {
    const { api, sent } = makeMockApi();
    initRelayAsk(api);
    const { client, fireAskRemote } = makeMockClient();
    attachAskRemoteToRelay(client);

    const longLabel =
      "An option with a label that is way longer than the Telegram button max";
    fireAskRemote({
      ...SAMPLE_REQ,
      options: [
        { label: longLabel, description: "lorem" },
        { label: "Short", description: undefined },
      ],
    });
    await sleep(0);

    const kb = (
      sent[0]!.opts?.reply_markup as {
        inline_keyboard: Array<Array<{ text: string }>>;
      }
    ).inline_keyboard;
    expect(kb[0]![0]!.text.length).toBeLessThanOrEqual(30);
    expect(kb[0]![0]!.text.endsWith("…")).toBe(true);
  });
});
