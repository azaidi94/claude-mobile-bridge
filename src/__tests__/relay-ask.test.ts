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
  _setTimeoutOvershootForTests,
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
  const disconnectHandlers: Array<() => void> = [];
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
    onDisconnect: (cb: () => void) => {
      disconnectHandlers.push(cb);
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
    fireDisconnect: () => {
      for (const h of disconnectHandlers) h();
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
    await handleAskRemoteCallback(api, "askremote:a1_test:custom", "cbq-1");
    // No answer yet — still pending.
    expect(sentAnswers).toHaveLength(0);
    expect(_pendingCountForTests()).toBe(1);
    expect(edits[0]!.text).toContain("Send your answer as a message");

    // User sends free-text in the same (chat, thread).
    const consumed = tryConsumeCustomTextAnswer(
      -1003968796171,
      33308,
      "Apply only fixture A but skip B",
    );
    expect(consumed).toBe(true);
    expect(sentAnswers).toEqual([
      { ask_id: "a1_test", answer: "Apply only fixture A but skip B" },
    ]);
    expect(_pendingCountForTests()).toBe(0);
  });

  test("custom-text in a chat without a pending custom-await is not consumed", () => {
    expect(tryConsumeCustomTextAnswer(99999, undefined, "hello")).toBe(false);
  });

  test("custom-text in a sibling topic is NOT consumed by another topic's open ask (bug_001)", async () => {
    const { api } = makeMockApi();
    initRelayAsk(api);
    const { client, fireAskRemote, sentAnswers } = makeMockClient("cdm-test");
    attachAskRemoteToRelay(client);

    // Topic 33308 has an open ask_remote awaiting custom text.
    fireAskRemote({ ...SAMPLE_REQ, ask_id: "a1", thread_id: "33308" });
    await sleep(0);
    await handleAskRemoteCallback(api, "askremote:a1:custom", "cbq-1");
    expect(_pendingCountForTests()).toBe(1);

    // User types in topic 33409 (sibling) — must NOT be consumed.
    const consumedSibling = tryConsumeCustomTextAnswer(
      -1003968796171,
      33409,
      "this should NOT be hijacked",
    );
    expect(consumedSibling).toBe(false);
    expect(sentAnswers).toHaveLength(0);
    // Original ask still pending in 33308.
    expect(_pendingCountForTests()).toBe(1);

    // Typing in the correct thread does consume it.
    const consumedSelf = tryConsumeCustomTextAnswer(
      -1003968796171,
      33308,
      "this answers the right ask",
    );
    expect(consumedSelf).toBe(true);
    expect(sentAnswers).toEqual([
      { ask_id: "a1", answer: "this answers the right ask" },
    ]);
  });

  test("two ask_remote in different topics of same chat coexist (bug_001 corollary)", async () => {
    const { api } = makeMockApi();
    initRelayAsk(api);
    const { client, fireAskRemote, sentAnswers } = makeMockClient("cdm-test");
    attachAskRemoteToRelay(client);

    fireAskRemote({ ...SAMPLE_REQ, ask_id: "aT1", thread_id: "33308" });
    await sleep(0);
    fireAskRemote({ ...SAMPLE_REQ, ask_id: "aT2", thread_id: "33409" });
    await sleep(0);

    // Both should be pending — duplicate guard is per-thread, not per-chat.
    expect(_pendingCountForTests()).toBe(2);

    // Tap custom on each — both slots populate.
    await handleAskRemoteCallback(api, "askremote:aT1:custom", "cbq-1");
    await handleAskRemoteCallback(api, "askremote:aT2:custom", "cbq-2");

    // Each thread's text resolves only its own ask.
    tryConsumeCustomTextAnswer(-1003968796171, 33308, "for T1");
    tryConsumeCustomTextAnswer(-1003968796171, 33409, "for T2");

    expect(sentAnswers).toEqual([
      { ask_id: "aT1", answer: "for T1" },
      { ask_id: "aT2", answer: "for T2" },
    ]);
  });

  test("cancel button sends error back + clears pending", async () => {
    const { api } = makeMockApi();
    initRelayAsk(api);
    const { client, fireAskRemote, sentAnswers } = makeMockClient();
    attachAskRemoteToRelay(client);

    fireAskRemote(SAMPLE_REQ);
    await sleep(0);

    await handleAskRemoteCallback(api, "askremote:a1_test:cancel", "cbq-1");
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

    await handleAskRemoteCallback(api, "askremote:a1_test:0", "cbq-1");

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

  test("rejects a second concurrent ask_remote with allow_custom in same chat", async () => {
    const { api } = makeMockApi();
    initRelayAsk(api);
    const { client, fireAskRemote, sentAnswers } = makeMockClient("cdm-test");
    attachAskRemoteToRelay(client);

    // First request — taps "custom" so customTextPending[chatId] is set.
    fireAskRemote(SAMPLE_REQ);
    await sleep(0);
    await handleAskRemoteCallback(api, "askremote:a1_test:custom", "cbq-1");

    // Second concurrent request in the same chat with allow_custom should
    // be rejected at delivery time. The mock client's catch path sends an
    // error frame back to the MCP via sendAskRemoteAnswer.
    fireAskRemote({
      ...SAMPLE_REQ,
      ask_id: "a2_test",
      question: "Concurrent",
    });
    await sleep(0);
    await sleep(0);

    const errAnswer = sentAnswers.find((s) => s.ask_id === "a2_test");
    expect(errAnswer).toBeDefined();
    expect(errAnswer!.error).toContain("already has an ask_remote");
    // Original ask is still pending; only the duplicate was rejected.
    expect(_pendingCountForTests()).toBe(1);
  });

  test("very long question + options are truncated before being sent to Telegram", async () => {
    const { api, sent } = makeMockApi();
    initRelayAsk(api);
    const { client, fireAskRemote } = makeMockClient("cdm-test");
    attachAskRemoteToRelay(client);

    fireAskRemote({
      ...SAMPLE_REQ,
      question: "Q".repeat(2000),
      options: [
        { label: "L".repeat(500), description: "D".repeat(1000) },
        { label: "Short", description: "ok" },
      ],
    });
    await sleep(0);

    expect(sent).toHaveLength(1);
    // Whole HTML (escaped + envelope) must be well under Telegram's 4096 limit
    // so sendMessage doesn't fail with "message is too long".
    expect(sent[0]!.text.length).toBeLessThan(4096);
  });

  test("bot-side timeout fires after the request's timeout_ms + overshoot", async () => {
    const { api } = makeMockApi();
    initRelayAsk(api);
    _setTimeoutOvershootForTests(20); // shrink 5s default to 20ms for speed
    const { client, fireAskRemote } = makeMockClient("cdm-test");
    attachAskRemoteToRelay(client);
    const { events, unsubscribe } = captureBusEvents("cdm-test");

    fireAskRemote({ ...SAMPLE_REQ, timeout_ms: 30 });
    await sleep(0);
    expect(_pendingCountForTests()).toBe(1);

    // Wait past timeout (30) + overshoot (20) + slack.
    await sleep(150);
    expect(_pendingCountForTests()).toBe(0);

    const cleared = events.find((e) => e.type === "ask_remote_cleared");
    expect(cleared?.askResolution).toBe("expired");

    unsubscribe();
  });

  test("relay disconnect cleans up bot-side pending asks (cloud bug #3)", async () => {
    const { api } = makeMockApi();
    initRelayAsk(api);
    const { client, fireAskRemote, fireDisconnect } =
      makeMockClient("cdm-test");
    attachAskRemoteToRelay(client);
    const { events, unsubscribe } = captureBusEvents("cdm-test");

    fireAskRemote(SAMPLE_REQ);
    await sleep(0);
    expect(_pendingCountForTests()).toBe(1);

    fireDisconnect();
    expect(_pendingCountForTests()).toBe(0);

    const cleared = events.find((e) => e.type === "ask_remote_cleared");
    expect(cleared?.askResolution).toBe("cancelled");
    unsubscribe();
  });

  test("relay disconnect only clears entries owned by THAT client (cloud bug #3)", async () => {
    const { api } = makeMockApi();
    initRelayAsk(api);
    const a = makeMockClient("session-a");
    const b = makeMockClient("session-b");
    attachAskRemoteToRelay(a.client);
    attachAskRemoteToRelay(b.client);

    // Different thread_ids so the per-(chat,thread) dup-custom guard
    // doesn't reject the second one.
    a.fireAskRemote({ ...SAMPLE_REQ, ask_id: "ask-from-a", thread_id: "1" });
    b.fireAskRemote({ ...SAMPLE_REQ, ask_id: "ask-from-b", thread_id: "2" });
    await sleep(0);
    expect(_pendingCountForTests()).toBe(2);

    // Only client A drops — client B's pending ask must be untouched.
    a.fireDisconnect();
    expect(_pendingCountForTests()).toBe(1);
  });
});
