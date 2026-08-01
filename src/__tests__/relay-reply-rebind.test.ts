/**
 * Regression test for the silent relay-reply drop after /clear.
 *
 * A watch binds its reply/file handler to the RelayClient instance that
 * existed at watch start. When /clear changes the sessionId, the next
 * sendWatchRelay looks the client up under the NEW id, gets a cache miss,
 * and connects a FRESH client — the relay server kicks the old connection,
 * and reply-tool payloads (files, send_as_pdf) arrive on a client with zero
 * bound callbacks: dropped silently while the MCP tool reports "Sent".
 *
 * The fix: sendWatchRelay must detect the client instance changed and rebind
 * the watch's handlers onto it.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

process.env.TELEGRAM_BOT_TOKEN ||= "test";
process.env.TELEGRAM_ALLOWED_USERS ||= "1";

// ── module mocks (resolve to the same modules relay-replies.ts imports) ──

const sendFileCalls: Array<{ file: string; threadId?: number }> = [];
const sendPdfCalls: Array<{ text: string; threadId?: number }> = [];
mock.module("../relay/display", () => ({
  sendFile: async (
    _botApi: unknown,
    _chatId: number,
    filePath: string,
    threadId?: number,
  ) => {
    sendFileCalls.push({ file: filePath, threadId });
  },
  sendPdfReply: async (
    _botApi: unknown,
    _chatId: number,
    text: string,
    _filename?: string,
    threadId?: number,
  ) => {
    sendPdfCalls.push({ text, threadId });
    return true;
  },
}));

mock.module("../messaging", () => ({
  getMessageBus: () => ({
    send: async () => ({ messageId: 1 }),
  }),
}));

// getRelayClient returns whatever the test sets `currentClient` to —
// simulating the cache returning a NEW client instance after /clear.
let currentClient: FakeRelayClient | null = null;
mock.module("../relay", () => ({
  getRelayClient: async () => currentClient,
}));

import type { RelayReply } from "../relay/client";
import type { SessionContext } from "../sessions/context";
import {
  sendWatchRelay,
  bindRelayReplyHandler,
  armRelayRebind,
} from "../handlers/watch/relay-replies";
import { watches, watchKey } from "../handlers/watch/registry";
import { buildWatchState } from "../handlers/watch/state";

// ── fake relay client ──

type Scoped = { cb: (msg: RelayReply) => void; chatId?: string };

class FakeRelayClient {
  scoped: Scoped[] = [];
  sent: unknown[] = [];
  onReply(cb: (msg: RelayReply) => void, chatId?: string): void {
    this.scoped.push({ cb, chatId });
  }
  offReply(cb: (msg: RelayReply) => void): void {
    this.scoped = this.scoped.filter((s) => s.cb !== cb);
  }
  sendMessage(msg: unknown): boolean {
    this.sent.push(msg);
    return true;
  }
  emitReply(msg: RelayReply): void {
    for (const { cb, chatId } of [...this.scoped]) {
      if (!chatId || chatId === msg.chat_id) cb(msg);
    }
  }
}

const CHAT_ID = -100123;
const THREAD_ID = 42;
const botApi = {} as never;

function makeWatch() {
  const state = buildWatchState({
    sessionName: "kx_repo",
    sessionId: "old-session-id",
    sessionDir: "/tmp/kx_repo",
    sessionPid: 111,
    chatId: CHAT_ID,
    threadId: THREAD_ID,
  });
  watches.set(watchKey(CHAT_ID, THREAD_ID), state);
  return state;
}

beforeEach(() => {
  watches.clear();
  sendFileCalls.length = 0;
  sendPdfCalls.length = 0;
  currentClient = null;
});

describe("relay reply rebinding after client replacement", () => {
  test("sendWatchRelay rebinds reply handler onto a new client instance", async () => {
    const state = makeWatch();
    const clientA = new FakeRelayClient();
    bindRelayReplyHandler(botApi, clientA as never, state, CHAT_ID, "watch");
    expect(clientA.scoped.length).toBe(1);

    // /clear happened: next lookup returns a FRESH client instance.
    const clientB = new FakeRelayClient();
    currentClient = clientB;

    const ok = await sendWatchRelay(CHAT_ID, THREAD_ID, "user", "resend it");
    expect(ok).toBe(true);

    // The new client must carry the watch's reply handler…
    expect(clientB.scoped.length).toBe(1);
    // …and the old client's stale handler must be released.
    expect(clientA.scoped.length).toBe(0);

    // A file reply arriving on the NEW client now reaches Telegram.
    clientB.emitReply({
      chat_id: String(CHAT_ID),
      text: "",
      files: ["/tmp/usage-billing-architecture.pdf"],
    });
    expect(sendFileCalls).toEqual([
      { file: "/tmp/usage-billing-architecture.pdf", threadId: THREAD_ID },
    ]);
  });

  test("sendWatchRelay does not rebind when the client is unchanged", async () => {
    const state = makeWatch();
    const clientA = new FakeRelayClient();
    bindRelayReplyHandler(botApi, clientA as never, state, CHAT_ID, "watch");
    currentClient = clientA;

    await sendWatchRelay(CHAT_ID, THREAD_ID, "user", "hello");
    await sendWatchRelay(CHAT_ID, THREAD_ID, "user", "again");

    // Still exactly one handler — no duplicate bindings stacking up.
    expect(clientA.scoped.length).toBe(1);
  });

  test("sctx pointing at a DIFFERENT session must not steal the watch's binding", async () => {
    const state = makeWatch(); // sessionId "old-session-id"
    const clientA = new FakeRelayClient();
    bindRelayReplyHandler(botApi, clientA as never, state, CHAT_ID, "watch");

    // Topic mode resolves a sibling session Y with its own relay client.
    const clientY = new FakeRelayClient();
    currentClient = clientY;
    const sctx = {
      sessionName: "kx_repo-2",
      sessionId: "sibling-session-y",
      sessionDir: "/tmp/kx_repo",
      sessionPid: 222,
    } as SessionContext;

    await sendWatchRelay(
      CHAT_ID,
      THREAD_ID,
      "user",
      "hi Y",
      undefined,
      undefined,
      sctx,
    );

    // The watch's persistent handler stays on ITS OWN session's client…
    expect(clientA.scoped.length).toBe(1);
    // …and is NOT cross-wired onto the sibling's client.
    expect(clientY.scoped.length).toBe(0);
  });

  test("sctx for the SAME session with a post-/clear NEW id still rebinds", async () => {
    // /clear regression: the topic store re-anchors sctx.sessionId to the NEW
    // id immediately (port-file hook), but state.sessionId lags until the
    // drift tick sees the new JSONL. Identity must match on the stable
    // sessionName, or the first post-/clear turn's attachments are lost.
    const state = makeWatch(); // sessionName "kx_repo", sessionId "old-session-id"
    const clientA = new FakeRelayClient();
    bindRelayReplyHandler(botApi, clientA as never, state, CHAT_ID, "watch");

    const clientB = new FakeRelayClient();
    currentClient = clientB;
    const sctx = {
      sessionName: "kx_repo",
      sessionId: "new-id-after-clear",
      sessionDir: "/tmp/kx_repo",
      sessionPid: 111,
    } as SessionContext;

    await sendWatchRelay(
      CHAT_ID,
      THREAD_ID,
      "user",
      "first message after /clear",
      undefined,
      undefined,
      sctx,
    );

    expect(clientB.scoped.length).toBe(1);
    expect(clientA.scoped.length).toBe(0);

    clientB.emitReply({
      chat_id: String(CHAT_ID),
      text: "",
      files: ["/tmp/post-clear.pdf"],
    });
    expect(sendFileCalls).toEqual([
      { file: "/tmp/post-clear.pdf", threadId: THREAD_ID },
    ]);
  });

  test("a watch that started with no relay client heals on first successful send", async () => {
    const state = makeWatch();
    // session-builder couldn't bind at watch start (relay down) but arms rebind.
    armRelayRebind(botApi, state, CHAT_ID, "auto-watch");

    const client = new FakeRelayClient();
    currentClient = client;
    await sendWatchRelay(CHAT_ID, THREAD_ID, "user", "are you back?");

    expect(client.scoped.length).toBe(1);
    client.emitReply({
      chat_id: String(CHAT_ID),
      text: "",
      files: ["/tmp/healed.pdf"],
    });
    expect(sendFileCalls).toEqual([
      { file: "/tmp/healed.pdf", threadId: THREAD_ID },
    ]);
  });

  test("relayCleanup after a rebind releases the NEW client's binding", async () => {
    const state = makeWatch();
    const clientA = new FakeRelayClient();
    bindRelayReplyHandler(botApi, clientA as never, state, CHAT_ID, "watch");

    const clientB = new FakeRelayClient();
    currentClient = clientB;
    await sendWatchRelay(CHAT_ID, THREAD_ID, "user", "resend");
    expect(clientB.scoped.length).toBe(1);

    state.relayCleanup?.(); // what stopWatching invokes
    expect(clientB.scoped.length).toBe(0);
  });

  test("send_as_pdf reply on the rebound client is delivered as a PDF", async () => {
    const state = makeWatch();
    const clientA = new FakeRelayClient();
    bindRelayReplyHandler(botApi, clientA as never, state, CHAT_ID, "watch");

    const clientB = new FakeRelayClient();
    currentClient = clientB;
    await sendWatchRelay(CHAT_ID, THREAD_ID, "user", "send the doc");

    clientB.emitReply({
      chat_id: String(CHAT_ID),
      text: "# Usage Billing",
      send_as_pdf: true,
    });
    expect(sendPdfCalls).toEqual([
      { text: "# Usage Billing", threadId: THREAD_ID },
    ]);
  });
});
