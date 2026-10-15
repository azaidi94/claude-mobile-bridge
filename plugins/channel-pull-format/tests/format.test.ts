import { test, expect } from "claude-code/testing";

const RELAYED =
  '<channel source="channel-relay" chat_id="-100" request_id="r1" user="RZA808" ts="t">\nhi\nthere\n</channel>';

test("formats channel-pull's prompts, leaves others as typed", async ($, on) => {
  const entered: { text: string; context?: readonly string[] }[] = [];
  on("prompt.submit", ($, e) => {
    entered.push({ text: e.text, context: e.context });
    return { text: e.text };
  });

  await $.prompt.submit({
    text: RELAYED,
    origin: { kind: "plugin", name: "channel-pull", asUser: true },
    wait: false,
  });
  await $.prompt.submit({
    text: RELAYED,
    origin: { kind: "plugin", name: "someone-else" },
    wait: false,
  });

  expect(entered).toEqual([
    {
      text: "📱 hi\nthere",
      context: [
        'The prompt above was relayed from Telegram by channel-relay: <channel source="channel-relay" chat_id="-100" request_id="r1" user="RZA808" ts="t" />. ' +
          'Treat it as a <channel source="channel-relay"> message: the user is on ' +
          "their phone, so answer as terminal text and ask multiple-choice questions " +
          "with the ask_remote tool, never AskUserQuestion.",
      ],
    },
    { text: RELAYED, context: undefined },
  ]);
});
