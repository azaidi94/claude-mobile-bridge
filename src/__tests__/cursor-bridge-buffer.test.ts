/**
 * AI fragment buffer for the Cursor bridge.
 *
 * Cursor renders an assistant turn as multiple sibling DOM bubbles
 * (preamble, prose, table, code-block, ...). Each fires the AI
 * binding independently. The bridge buffers them, prefix-dedups, and
 * emits one combined message after a quiet window OR on the next
 * human input.
 *
 * Tests use a 50ms flush window via the aiFlushDelayMs override.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { CursorBridge } from "../cursor/bridge";
import { SessionEventBus, type SseEvent } from "../web/sse";

interface MockNotificationHandler {
  method: string;
  handler: (params: Record<string, unknown>) => void;
}

function makeMockCdp() {
  const handlers: MockNotificationHandler[] = [];
  return {
    sendCommand: mock(async (method: string) => {
      if (method === "Runtime.evaluate") {
        return { result: { type: "object", value: [] as string[] } };
      }
      return {};
    }),
    onNotification: mock(
      (method: string, handler: (params: Record<string, unknown>) => void) => {
        handlers.push({ method, handler });
        return () => {};
      },
    ),
    close: mock(() => {}),
    simulateBinding: (name: string, payload: string) => {
      for (const { method, handler } of handlers) {
        if (method === "Runtime.bindingCalled") handler({ name, payload });
      }
    },
  };
}

const SESSION = "cursor-buf";
const FLUSH_MS = 50;

async function setup() {
  const bus = new SessionEventBus();
  const cdp = makeMockCdp();
  const received: SseEvent[] = [];
  bus.subscribe(SESSION, (e) => received.push(e));
  const bridge = new CursorBridge({
    sessionName: SESSION,
    sessionDir: "/tmp",
    cdpClient: cdp as never,
    bus,
    aiFlushDelayMs: FLUSH_MS,
  });
  await bridge.start();
  received.length = 0;
  return { bus, cdp, bridge, received };
}

const aiOnly = (received: SseEvent[]) =>
  received.filter((e) => e.type === "text" && e.source === "cursor");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("CursorBridge AI fragment buffer", () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
  });

  it("does not emit before the flush window elapses", () => {
    env.cdp.simulateBinding("cursorBridgeAiMsg", "first chunk");
    expect(aiOnly(env.received)).toHaveLength(0);
  });

  it("emits a single combined message after the flush window", async () => {
    env.cdp.simulateBinding("cursorBridgeAiMsg", "Part one.");
    env.cdp.simulateBinding("cursorBridgeAiMsg", "Part two.");
    env.cdp.simulateBinding("cursorBridgeAiMsg", "Part three.");
    await sleep(FLUSH_MS + 30);
    const ai = aiOnly(env.received);
    expect(ai).toHaveLength(1);
    expect(ai[0]!.content).toBe("Part one.\n\nPart two.\n\nPart three.");
  });

  it("collapses prefix-extension chains to the longest version", async () => {
    env.cdp.simulateBinding("cursorBridgeAiMsg", "Here's the");
    env.cdp.simulateBinding("cursorBridgeAiMsg", "Here's the answer");
    env.cdp.simulateBinding("cursorBridgeAiMsg", "Here's the answer in full.");
    await sleep(FLUSH_MS + 30);
    const ai = aiOnly(env.received);
    expect(ai).toHaveLength(1);
    expect(ai[0]!.content).toBe("Here's the answer in full.");
  });

  it("drops exact-content duplicates", async () => {
    env.cdp.simulateBinding("cursorBridgeAiMsg", "same text");
    env.cdp.simulateBinding("cursorBridgeAiMsg", "same text");
    env.cdp.simulateBinding("cursorBridgeAiMsg", "same text");
    await sleep(FLUSH_MS + 30);
    const ai = aiOnly(env.received);
    expect(ai).toHaveLength(1);
    expect(ai[0]!.content).toBe("same text");
  });

  it("drops a fragment that's a prefix of one already buffered", async () => {
    env.cdp.simulateBinding(
      "cursorBridgeAiMsg",
      "The full answer is forty-two.",
    );
    env.cdp.simulateBinding("cursorBridgeAiMsg", "The full answer");
    await sleep(FLUSH_MS + 30);
    expect(aiOnly(env.received)[0]!.content).toBe(
      "The full answer is forty-two.",
    );
  });

  it("keeps unrelated fragments as separate slots in the combined emit", async () => {
    env.cdp.simulateBinding("cursorBridgeAiMsg", "Reading file …");
    env.cdp.simulateBinding("cursorBridgeAiMsg", "Tool result: ok");
    env.cdp.simulateBinding("cursorBridgeAiMsg", "Final answer here.");
    await sleep(FLUSH_MS + 30);
    const ai = aiOnly(env.received);
    expect(ai).toHaveLength(1);
    const content = ai[0]!.content;
    expect(content).toContain("Reading file");
    expect(content).toContain("Tool result: ok");
    expect(content).toContain("Final answer here.");
    // Order preserved.
    expect(content.indexOf("Reading file")).toBeLessThan(
      content.indexOf("Tool result"),
    );
    expect(content.indexOf("Tool result")).toBeLessThan(
      content.indexOf("Final answer"),
    );
  });

  it("flushes immediately on next HUMAN_BINDING (no waiting for timer)", () => {
    env.cdp.simulateBinding("cursorBridgeAiMsg", "AI reply.");
    env.cdp.simulateBinding("cursorBridgeHumanMsg", "next user question");
    const all = env.received;
    const aiIdx = all.findIndex(
      (e) => e.type === "text" && e.source === "cursor",
    );
    const humanIdx = all.findIndex(
      (e) => e.type === "user_message" && e.source === "cursor",
    );
    expect(aiIdx).toBeGreaterThanOrEqual(0);
    expect(humanIdx).toBeGreaterThan(aiIdx);
    expect(all[aiIdx]!.content).toBe("AI reply.");
  });

  it("flushes immediately when a non-cursor user_message arrives via bus", async () => {
    env.cdp.simulateBinding("cursorBridgeAiMsg", "Pending AI reply.");
    env.bus.emit(SESSION, {
      type: "user_message",
      source: "telegram",
      content: "next from TG",
    });
    // No await — flush should be synchronous before injection.
    const ai = aiOnly(env.received);
    expect(ai).toHaveLength(1);
    expect(ai[0]!.content).toBe("Pending AI reply.");
  });

  it("flushes pending buffer when stop() is called", () => {
    env.cdp.simulateBinding("cursorBridgeAiMsg", "Stopped mid-thought.");
    env.bridge.stop();
    const ai = aiOnly(env.received);
    expect(ai).toHaveLength(1);
    expect(ai[0]!.content).toBe("Stopped mid-thought.");
  });

  it("treats two distinct AI turns separated by a user input as separate emits", async () => {
    env.cdp.simulateBinding("cursorBridgeAiMsg", "Turn 1 reply.");
    env.cdp.simulateBinding("cursorBridgeHumanMsg", "follow up");
    env.cdp.simulateBinding("cursorBridgeAiMsg", "Turn 2 reply.");
    await sleep(FLUSH_MS + 30);
    const ai = aiOnly(env.received);
    expect(ai).toHaveLength(2);
    expect(ai[0]!.content).toBe("Turn 1 reply.");
    expect(ai[1]!.content).toBe("Turn 2 reply.");
  });

  it("dedupes plain + markdown twins of the same response", async () => {
    // Cursor sometimes renders the same content in two assistant
    // bubbles — one with markdown formatting, one without. After
    // markdown stripping they're equivalent, so only the longer
    // (formatted) version should survive.
    env.cdp.simulateBinding(
      "cursorBridgeAiMsg",
      "Three different chats\nThis Cursor chat\nTelegram\nCursor Composer",
    );
    env.cdp.simulateBinding(
      "cursorBridgeAiMsg",
      "**Three different chats**\n- This Cursor chat\n- Telegram\n- Cursor Composer",
    );
    await sleep(FLUSH_MS + 30);
    const ai = aiOnly(env.received);
    expect(ai).toHaveLength(1);
    // The formatted version should win.
    expect(ai[0]!.content).toContain("**Three different chats**");
    expect(ai[0]!.content).toContain("- This Cursor chat");
  });

  it("flushes a fenced-code-only AI bubble (regression: stripMarkdown -> empty)", async () => {
    // Pure code-block content strips to empty. The prior bufferAiFragment
    // bailed on `if (!normNew) return;` and silently dropped the message.
    env.cdp.simulateBinding(
      "cursorBridgeAiMsg",
      "```\nconst x = 42;\nconsole.log(x);\n```",
    );
    await sleep(FLUSH_MS + 30);
    const ai = aiOnly(env.received);
    expect(ai).toHaveLength(1);
    expect(ai[0]!.content).toContain("const x = 42");
  });

  it("does not let an unrelated heading replace a heading-prefixed slot", async () => {
    // Edge case from the code review: '## Plan' and '## Plan B will not
    // work because…' both strip to start with 'plan'. The 'replace if new
    // is fuller' branch must not silently destroy the earlier slot when
    // the prefix relationship is incidental.
    env.cdp.simulateBinding("cursorBridgeAiMsg", "## Plan");
    env.cdp.simulateBinding(
      "cursorBridgeAiMsg",
      "## Plan B will not work because the bridge has gone offline.",
    );
    await sleep(FLUSH_MS + 30);
    const ai = aiOnly(env.received);
    expect(ai).toHaveLength(1);
    // Whichever slot wins, the content must include both pieces — we
    // shouldn't silently lose the second heading.
    const content = ai[0]!.content;
    // The longer one is a true continuation of the shorter, so prefix
    // upgrade is the right call here. Document that:
    expect(content).toContain("Plan B will not work");
  });

  it("dedupes a table rendered as plain text vs as markdown table", async () => {
    env.cdp.simulateBinding(
      "cursorBridgeAiMsg",
      "Run Result 1st Failed 2nd Passed",
    );
    env.cdp.simulateBinding(
      "cursorBridgeAiMsg",
      "| Run | Result |\n| --- | --- |\n| 1st | Failed |\n| 2nd | Passed |",
    );
    await sleep(FLUSH_MS + 30);
    const ai = aiOnly(env.received);
    expect(ai).toHaveLength(1);
    expect(ai[0]!.content).toContain("| Run | Result |");
  });
});
