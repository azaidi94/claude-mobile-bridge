import { test, expect } from "claude-code/testing";

const RELAYED =
  '<channel source="channel-relay" chat_id="-100" request_id="r1" user="RZA808" ts="t">\nhi\nthere\n</channel>';

test("formats bridge's (and channel-pull's) prompts, leaves others as typed", async ($, on) => {
  const entered: { text: string; context?: readonly string[] }[] = [];
  on("prompt.submit", ($, e) => {
    entered.push({ text: e.text, context: e.context });
    return { text: e.text };
  });

  for (const name of ["bridge", "channel-pull", "someone-else"]) {
    await $.prompt.submit({
      text: RELAYED,
      origin: { kind: "plugin", name, asUser: true },
      wait: false,
    });
  }

  expect(entered.map((p) => p.text)).toEqual([
    "📱 hi\nthere",
    "📱 hi\nthere",
    RELAYED,
  ]);
  expect(entered[0]!.context?.[0]).toContain(
    'relayed from Telegram by channel-relay: <channel source="channel-relay" chat_id="-100" request_id="r1" user="RZA808" ts="t" />',
  );
  expect(entered[0]!.context?.[0]).toContain("ask_remote");
  expect(entered[2]!.context).toBeUndefined();
});
