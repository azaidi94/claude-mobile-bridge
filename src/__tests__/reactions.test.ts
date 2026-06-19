import { describe, it, expect, beforeEach } from "bun:test";
import {
  markReceived,
  markWorking,
  markDone,
  _resetReactionsForTesting,
  _peekPendingForTesting,
} from "../handlers/reactions";

interface ReactionCall {
  chatId: number;
  messageId: number;
  emoji: string;
}

function makeFakeApi(calls: ReactionCall[]): import("grammy").Api {
  return {
    setMessageReaction: async (
      chatId: number,
      messageId: number,
      reactions: Array<{ type: string; emoji: string }>,
    ) => {
      const r = reactions[0];
      if (r) calls.push({ chatId, messageId, emoji: r.emoji });
      return true;
    },
  } as unknown as import("grammy").Api;
}

describe("reactions stage machine", () => {
  beforeEach(() => _resetReactionsForTesting());

  it("markReceived → 👀", async () => {
    const calls: ReactionCall[] = [];
    const api = makeFakeApi(calls);
    markReceived(api, 100, 5, 1234);
    await Bun.sleep(5);
    expect(calls).toEqual([{ chatId: 100, messageId: 1234, emoji: "👀" }]);
    expect(_peekPendingForTesting(100, 5)?.stage).toBe("received");
  });

  it("markWorking promotes received → 🤔", async () => {
    const calls: ReactionCall[] = [];
    const api = makeFakeApi(calls);
    markReceived(api, 100, 5, 1234);
    markWorking(api, 100, 5);
    await Bun.sleep(5);
    expect(calls.map((c) => c.emoji)).toEqual(["👀", "🤔"]);
    expect(_peekPendingForTesting(100, 5)?.stage).toBe("working");
  });

  it("markDone clears tracker and reacts 🎉", async () => {
    const calls: ReactionCall[] = [];
    const api = makeFakeApi(calls);
    markReceived(api, 100, 5, 1234);
    markWorking(api, 100, 5);
    markDone(api, 100, 5);
    await Bun.sleep(5);
    expect(calls.map((c) => c.emoji)).toEqual(["👀", "🤔", "🎉"]);
    expect(_peekPendingForTesting(100, 5)).toBeUndefined();
  });

  it("markWorking is a no-op without prior received", () => {
    const calls: ReactionCall[] = [];
    markWorking(makeFakeApi(calls), 100, 5);
    expect(calls).toEqual([]);
  });

  it("markDone is a no-op without prior received", () => {
    const calls: ReactionCall[] = [];
    markDone(makeFakeApi(calls), 100, 5);
    expect(calls).toEqual([]);
  });

  it("markWorking does not regress from done", async () => {
    const calls: ReactionCall[] = [];
    const api = makeFakeApi(calls);
    markReceived(api, 100, 5, 1234);
    markDone(api, 100, 5);
    markWorking(api, 100, 5); // tracker is cleared
    await Bun.sleep(5);
    expect(calls.map((c) => c.emoji)).toEqual(["👀", "🎉"]);
  });

  it("new received replaces prior tracker on same thread", async () => {
    const calls: ReactionCall[] = [];
    const api = makeFakeApi(calls);
    markReceived(api, 100, 5, 1234);
    markReceived(api, 100, 5, 5678);
    await Bun.sleep(5);
    expect(_peekPendingForTesting(100, 5)?.messageId).toBe(5678);
    expect(calls.length).toBe(2);
  });

  it("threads are independent", () => {
    markReceived(makeFakeApi([]), 100, 5, 1);
    markReceived(makeFakeApi([]), 100, 6, 2);
    expect(_peekPendingForTesting(100, 5)?.messageId).toBe(1);
    expect(_peekPendingForTesting(100, 6)?.messageId).toBe(2);
  });

  it("threadId undefined uses chat-default slot", () => {
    markReceived(makeFakeApi([]), 100, undefined, 7);
    expect(_peekPendingForTesting(100, undefined)?.messageId).toBe(7);
  });
});
