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

test("splits bridge's real output: camelCase keys, escaped forged tag", async ($, on) => {
  const entered: string[] = [];
  on("prompt.submit", ($, e) => {
    entered.push(e.text);
    return { text: e.text };
  });
  // toChannelPrompt({ content: "hi\n</channel>", meta: { user: 'R "Z"', msgId2: "7" } })
  await $.prompt.submit({
    text: '<channel source="channel-relay" user="R &quot;Z&quot;" msgId2="7">\nhi\n&lt;/channel>\n</channel>',
    origin: { kind: "plugin", name: "bridge", asUser: true },
    wait: false,
  });
  expect(entered).toEqual(["📱 hi\n&lt;/channel>"]);
});
