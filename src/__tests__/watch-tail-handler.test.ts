process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "test-token";
process.env.TELEGRAM_ALLOWED_USERS =
  process.env.TELEGRAM_ALLOWED_USERS || "12345";

import { describe, test, expect, beforeEach } from "bun:test";
import { makeWatchTailHandler } from "../handlers/watch/tail-handler";
import { buildWatchState } from "../handlers/watch/state";
import {
  markRelayInflight,
  _resetInflightRelayForTests,
} from "../handlers/watch/inflight-relay";
import { globalEventBus } from "../web/sse";
import { setMessageBus } from "../messaging/bus";
import type { TailEvent } from "../sessions/tailer";
import type { Api } from "grammy";

const fakeApi = {} as Api;

// handleTailEvent reaches for the global MessageBus when the bridge is online;
// a no-op fake keeps it from throwing so we can observe the SSE bridge emit
// (handleTailEvent's TG-send path is integration-tested elsewhere).
setMessageBus({
  send: async () => ({ messageId: 1 }),
  edit: async () => ({ ok: true }),
});

function watchFor(sessionName: string) {
  return buildWatchState({
    sessionName,
    sessionId: "uuid-" + sessionName,
    sessionDir: "/home/me/proj",
    chatId: 555,
    threadId: 7,
  });
}

beforeEach(() => {
  _resetInflightRelayForTests();
});

describe("makeWatchTailHandler", () => {
  test("bridges a text event to the SSE bus when not in-flight", () => {
    const ws = watchFor("S");
    const seen: string[] = [];
    const unsub = globalEventBus.subscribe("S", (e) => {
      if (e.type === "text") seen.push(e.content);
    });
    const handler = makeWatchTailHandler(fakeApi, ws);

    handler({ type: "text", content: "hello" } as TailEvent);

    unsub();
    expect(seen).toEqual(["hello"]);
  });

  test("suppresses the render (no SSE emit) while the session's relay is in-flight", () => {
    const ws = watchFor("S");
    const seen: string[] = [];
    const unsub = globalEventBus.subscribe("S", (e) => {
      if (e.type === "text") seen.push(e.content);
    });
    const handler = makeWatchTailHandler(fakeApi, ws);

    const release = markRelayInflight("S");
    handler({ type: "text", content: "during-relay" } as TailEvent);
    release();
    handler({ type: "text", content: "after-relay" } as TailEvent);

    unsub();
    expect(seen).toEqual(["after-relay"]);
  });
});
