import { describe, test, expect } from "bun:test";
import {
  classifyOrigin,
  extractChannelChatId,
  classifyTranscript,
} from "../../hooks/claude-remote-auq-gate";

function userLine(
  originKind: string | undefined,
  text: string,
  opts: { toolResult?: boolean } = {},
): string {
  const content = opts.toolResult
    ? [{ type: "tool_result", content: text }]
    : [{ type: "text", text }];
  const entry: Record<string, unknown> = {
    type: "user",
    message: { role: "user", content },
  };
  if (originKind !== undefined) entry.origin = { kind: originKind };
  return JSON.stringify(entry);
}

const TG_TAG =
  '<channel source="channel-relay" chat_id="-1003968796171" request_id="r1" user="az">\nhi\n</channel>';

describe("classifyOrigin", () => {
  test("channel → remote, human → local, else null", () => {
    expect(classifyOrigin("channel")).toBe("remote");
    expect(classifyOrigin("human")).toBe("local");
    expect(classifyOrigin(undefined)).toBeNull();
    expect(classifyOrigin("other")).toBeNull();
  });
});

describe("extractChannelChatId", () => {
  test("pulls chat_id from a genuine channel tag", () => {
    expect(extractChannelChatId(TG_TAG)).toBe("-1003968796171");
  });
  test("undefined when no channel tag", () => {
    expect(
      extractChannelChatId("just text mentioning channel-relay"),
    ).toBeUndefined();
  });
});

describe("classifyTranscript (last surface wins)", () => {
  test("last real prompt from channel → remote + chatId", () => {
    const r = classifyTranscript([
      userLine("human", "earlier terminal msg"),
      userLine("channel", TG_TAG),
    ]);
    expect(r).toEqual({ surface: "remote", chatId: "-1003968796171" });
  });

  test("last real prompt from terminal → local", () => {
    const r = classifyTranscript([
      userLine("channel", TG_TAG),
      userLine("human", "back at the desktop now"),
    ]);
    expect(r).toEqual({ surface: "local" });
  });

  test("tool_results after a channel prompt don't change the surface (autonomous case)", () => {
    const r = classifyTranscript([
      userLine("channel", TG_TAG),
      userLine(undefined, "bash output 1", { toolResult: true }),
      userLine(undefined, "bash output 2", { toolResult: true }),
    ]);
    expect(r.surface).toBe("remote");
  });

  test("a terminal paste that mentions channel-relay is still local", () => {
    const r = classifyTranscript([
      userLine(
        "human",
        "here is a transcript that says channel-relay and chat_id everywhere",
      ),
    ]);
    expect(r).toEqual({ surface: "local" });
  });

  test("None-origin prompts are skipped to find the last human/channel turn", () => {
    const r = classifyTranscript([
      userLine("channel", TG_TAG),
      userLine(undefined, "<command-name>/clear</command-name>"),
    ]);
    expect(r.surface).toBe("remote");
  });

  test("empty / unparseable transcript defaults to local", () => {
    expect(classifyTranscript([])).toEqual({ surface: "local" });
    expect(classifyTranscript(["not json", "{bad"]).surface).toBe("local");
  });
});
