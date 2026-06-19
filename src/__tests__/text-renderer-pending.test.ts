/**
 * renderText in-flight-send races: a render arriving while the initial
 * bubble send is pending must not be lost — once the send resolves, the
 * accumulated content should be delivered via a catch-up edit. A segment
 * reset during the pending window must not resurrect the stale bubble.
 */

import "./ensure-test-env";
import { describe, expect, test, mock } from "bun:test";
import type { Api } from "grammy";

interface PendingSend {
  content: string;
  resolve: (r: { messageId: number } | { dropped: string }) => void;
}
const sends: PendingSend[] = [];
const edits: { messageId: number; content: string }[] = [];

mock.module("../messaging", () => ({
  getMessageBus: () => ({
    send: (m: { content: string }) =>
      new Promise((resolve) => sends.push({ content: m.content, resolve })),
    edit: (messageId: number, m: { content: string }) => {
      edits.push({ messageId, content: m.content });
      return Promise.resolve({ ok: true as const });
    },
  }),
}));

import {
  renderText,
  resetDisplaySegment,
} from "../handlers/watch/text-renderer";
import type { TailDisplayState } from "../handlers/watch/state";
import type { TailEvent } from "../sessions/tailer";

const fakeApi = {
  deleteMessage: () => Promise.resolve(true),
} as unknown as Api;

function makeState(): TailDisplayState {
  return {
    chatId: 1,
    currentToolMsg: null,
    currentTextMsg: null,
    currentTextContent: "",
    lastTextUpdate: 0,
    segmentDone: true,
    progressMessages: [],
  };
}

function textEvent(content: string): TailEvent {
  return { type: "text", content };
}

async function flushMicrotasks(): Promise<void> {
  await Bun.sleep(0);
}

describe("renderText pending-send races", () => {
  test("content arriving while send is in flight is delivered via catch-up edit", async () => {
    sends.length = 0;
    edits.length = 0;
    const state = makeState();

    renderText(fakeApi, state, textEvent("Hello "), undefined);
    expect(sends.length).toBe(1);
    expect(state.textMsgPending).toBe(true);

    // Second chunk arrives before the send resolves (defeat the throttle).
    state.lastTextUpdate = 0;
    renderText(fakeApi, state, textEvent("world"), undefined);
    expect(sends.length).toBe(1); // no second bubble

    sends[0]!.resolve({ messageId: 42 });
    await flushMicrotasks();

    expect(state.currentTextMsg?.message_id).toBe(42);
    expect(edits.length).toBe(1);
    expect(edits[0]!.messageId).toBe(42);
    expect(edits[0]!.content).toBe("Hello world");
  });

  test("no catch-up edit when nothing accumulated while pending", async () => {
    sends.length = 0;
    edits.length = 0;
    const state = makeState();

    renderText(fakeApi, state, textEvent("Hello"), undefined);
    sends[0]!.resolve({ messageId: 43 });
    await flushMicrotasks();

    expect(state.currentTextMsg?.message_id).toBe(43);
    expect(edits.length).toBe(0);
  });

  test("segment reset while send is pending does not resurrect the stale bubble", async () => {
    sends.length = 0;
    edits.length = 0;
    const state = makeState();

    renderText(fakeApi, state, textEvent("partial"), undefined);
    resetDisplaySegment(fakeApi, state);

    sends[0]!.resolve({ messageId: 44 });
    await flushMicrotasks();

    // The resolved stub must not leak into the (already reset) next segment.
    expect(state.currentTextMsg).toBeNull();
  });
});
