import "./ensure-test-env";
import { describe, test, expect } from "bun:test";

async function load() {
  return import(`${import.meta.dir}/../../hooks/claude-remote-auq-worker.ts`);
}

describe("worker: generateTmuxKeys", () => {
  test("labelled option → digit + Enter", async () => {
    const { generateTmuxKeys } = await load();
    const keys = generateTmuxKeys({
      pane: "%12",
      question: { options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
      answer: "B",
    });
    expect(keys).toEqual([
      ["send-keys", "-t", "%12", "Escape"],
      ["send-keys", "-t", "%12", "2", "Enter"],
    ]);
  });

  test("custom text → 'Type something' option + text + Enter", async () => {
    const { generateTmuxKeys } = await load();
    const keys = generateTmuxKeys({
      pane: "%12",
      question: { options: [{ label: "A" }, { label: "B" }] },
      answer: "some custom thing",
    });
    expect(keys).toEqual([
      ["send-keys", "-t", "%12", "Escape"],
      ["send-keys", "-t", "%12", "3", "Enter"],
      ["send-keys", "-t", "%12", "some custom thing", "Enter"],
    ]);
  });

  test("custom text with special chars passes through (tmux send-keys handles its own escaping)", async () => {
    const { generateTmuxKeys } = await load();
    const keys = generateTmuxKeys({
      pane: "%12",
      question: { options: [{ label: "A" }, { label: "B" }] },
      answer: "weird ' \" ; `chars`",
    });
    expect(keys[2]).toEqual([
      "send-keys",
      "-t",
      "%12",
      "weird ' \" ; `chars`",
      "Enter",
    ]);
  });
});
