/**
 * finalizeTextMessage is the only write of a segment's complete text. Every
 * other edit is a throttled intermediate snapshot the next one supersedes, so
 * a dropped final edit leaves the bubble frozen mid-sentence — and it fires at
 * the end of a burst, when the edit lane is deepest. It must retry.
 */

import "./ensure-test-env";
import { describe, expect, test, mock } from "bun:test";
import type { Api } from "grammy";

type EditResult = { ok: true } | { ok: false; reason: string };
const edits: { messageId: number; content: string }[] = [];
let editOutcomes: EditResult[] = [];

mock.module("../messaging", () => ({
  getMessageBus: () => ({
    send: () => Promise.resolve({ messageId: 1 }),
    edit: (messageId: number, m: { content: string }) => {
      edits.push({ messageId, content: m.content });
      return Promise.resolve(editOutcomes.shift() ?? { ok: true });
    },
  }),
}));

import {
  finalizeTextMessage,
  finalizeWithRetry,
} from "../handlers/watch/text-renderer";
import type { TailDisplayState } from "../handlers/watch/state";

const fakeApi = {
  deleteMessage: () => Promise.resolve(true),
} as unknown as Api;

const noSleep = () => Promise.resolve();

function reset(outcomes: EditResult[] = []) {
  edits.length = 0;
  editOutcomes = outcomes;
}

describe("finalizeWithRetry", () => {
  test("retries a refused final edit until it lands", async () => {
    reset([
      { ok: false, reason: "outbound edit lane overloaded" },
      { ok: false, reason: "outbound edit lane overloaded" },
      { ok: true },
    ]);
    const landed = await finalizeWithRetry(42, 1, "final text", noSleep);
    expect(landed).toBe(true);
    expect(edits.length).toBe(3);
    // Every attempt carries the SAME complete text, not a snapshot.
    expect(edits.every((e) => e.content === "final text")).toBe(true);
    expect(edits.every((e) => e.messageId === 42)).toBe(true);
  });

  test("gives up after the retry budget and reports it", async () => {
    reset([
      { ok: false, reason: "boom" },
      { ok: false, reason: "boom" },
      { ok: false, reason: "boom" },
      { ok: false, reason: "boom" },
    ]);
    const landed = await finalizeWithRetry(42, 1, "final text", noSleep);
    expect(landed).toBe(false);
    // 1 initial + 2 retries.
    expect(edits.length).toBe(3);
  });

  test("'message is not modified' means the text is already on screen — no retry", async () => {
    reset([
      {
        ok: false,
        reason:
          "Call to 'editMessageText' failed! (400: Bad Request: message is not modified)",
      },
    ]);
    const landed = await finalizeWithRetry(42, 1, "final text", noSleep);
    expect(landed).toBe(true);
    expect(edits.length).toBe(1);
  });

  test("a deleted target is not retried", async () => {
    reset([{ ok: false, reason: "message to edit not found" }]);
    await finalizeWithRetry(42, 1, "final text", noSleep);
    expect(edits.length).toBe(1);
  });
});

describe("finalizeTextMessage", () => {
  test("captures the message and text before clearing the segment", async () => {
    reset([{ ok: true }]);
    const state: TailDisplayState = {
      chatId: 7,
      currentToolMsg: null,
      currentTextMsg: { message_id: 99 } as any,
      currentTextContent: "the whole paragraph",
      lastTextUpdate: 0,
      segmentDone: false,
      progressMessages: [],
    };

    finalizeTextMessage(fakeApi, state);

    // Segment cleared synchronously...
    expect(state.currentTextMsg).toBeNull();
    expect(state.currentTextContent).toBe("");
    expect(state.segmentDone).toBe(true);

    // ...but the edit still targets what was there.
    await Bun.sleep(0);
    expect(edits).toEqual([{ messageId: 99, content: "the whole paragraph" }]);
  });
});
