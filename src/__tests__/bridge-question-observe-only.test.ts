import "./ensure-test-env";
import { describe, expect, test } from "bun:test";
import { sendBridgeQuestion } from "../handlers/relay-ask";
import type { Api } from "grammy";

interface SentCall {
  text: string;
  opts: { reply_markup?: unknown };
}

function fakeApi(sink: SentCall[]): Api {
  return {
    sendMessage: async (
      _chatId: number,
      text: string,
      opts: SentCall["opts"],
    ) => {
      sink.push({ text, opts });
      return { message_id: 1 };
    },
  } as unknown as Api;
}

const baseArgs = {
  requestId: "req-1",
  questionIndex: 0,
  chatId: 100,
  threadId: 7,
  question: "Pick one",
  options: [{ label: "A" }, { label: "B" }],
  allowCustom: true,
};

describe("sendBridgeQuestion observe-only", () => {
  test("normal (answerable) card has tappable buttons and no observe-only footer", async () => {
    const sent: SentCall[] = [];
    await sendBridgeQuestion(fakeApi(sent), baseArgs);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.opts.reply_markup).toBeDefined();
    expect(sent[0]!.text.toLowerCase()).not.toContain("observe-only");
  });

  test("observe-only card omits the answer keyboard and adds a desktop footer", async () => {
    const sent: SentCall[] = [];
    await sendBridgeQuestion(fakeApi(sent), { ...baseArgs, observeOnly: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.opts.reply_markup).toBeUndefined();
    expect(sent[0]!.text.toLowerCase()).toContain("observe-only");
    expect(sent[0]!.text.toLowerCase()).toContain("desktop");
  });
});
