/**
 * Unit tests for the watch image renderer (handlers/watch/image.ts).
 *
 * Verifies: photo vs document selection by media_type, caption derivation
 * from the tool registry, and byte-identical-frame dedup via state.lastImageHash.
 */

import "./ensure-test-env";
import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { TailEvent } from "../sessions/tailer";
import type { TailDisplayState } from "../handlers/watch/state";

interface Sent {
  kind?: string;
  filename?: string;
  caption: string;
  hasBytes: boolean;
  path?: string;
}
const sent: Sent[] = [];
const mockBusSend = mock(async (input: any) => {
  sent.push({
    kind: input.attachment?.kind,
    filename: input.attachment?.filename,
    caption: input.content,
    hasBytes: Buffer.isBuffer(input.attachment?.bytes),
    path: input.attachment?.path,
  });
  return { messageId: 1 };
});

mock.module("../messaging", () => ({
  getMessageBus: () => ({ send: mockBusSend, edit: mock(() => {}) }),
  setMessageBus: mock(() => {}),
  createMessageBus: mock(() => ({ send: mockBusSend, edit: mock(() => {}) })),
}));

const { renderImage } = await import("../handlers/watch/image");

function baseState(): TailDisplayState {
  return {
    chatId: 1,
    currentToolMsg: null,
    currentTextMsg: null,
    currentTextContent: "",
    lastTextUpdate: 0,
    segmentDone: true,
  };
}

function imageEvent(
  data: string,
  mediaType: string,
  toolUseId?: string,
): TailEvent {
  return {
    type: "image",
    content: "",
    toolUseId,
    image: { mediaType, dataBase64: data },
  };
}

describe("renderImage", () => {
  beforeEach(() => {
    sent.length = 0;
    mockBusSend.mockClear();
  });

  test("jpeg/png → photo with extension; caption from tool registry", async () => {
    const state = baseState();
    state.toolUseRegistry = new Map([["t1", "claude-in-chrome"]]);
    renderImage({} as any, state, imageEvent("AAAA", "image/jpeg", "t1"), 99);
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.kind).toBe("photo");
    expect(sent[0]!.filename).toBe("image.jpg");
    expect(sent[0]!.hasBytes).toBe(true);
    expect(sent[0]!.caption).toContain("claude-in-chrome");
  });

  test("non-image media_type → document", async () => {
    const state = baseState();
    renderImage({} as any, state, imageEvent("BBBB", "application/pdf"), 1);
    await Promise.resolve();
    expect(sent[0]!.kind).toBe("document");
    expect(sent[0]!.filename).toBe("image.bin");
  });

  test("oversized image (>10MB) falls back to document but keeps extension", async () => {
    const state = baseState();
    // base64 of ~11MB of bytes: 11MB * 4/3 chars. Use a string that decodes >10MB.
    const big = "A".repeat(15 * 1024 * 1024); // decodes to ~11.25MB
    renderImage({} as any, state, imageEvent(big, "image/png"), 1);
    await Promise.resolve();
    expect(sent[0]!.kind).toBe("document");
    expect(sent[0]!.filename).toBe("image.png");
  });

  test("mcp__ tool names are cleaned in the caption", async () => {
    const state = baseState();
    state.toolUseRegistry = new Map([
      ["t1", "mcp__claude-in-chrome__computer"],
    ]);
    renderImage({} as any, state, imageEvent("ZZZZ", "image/png", "t1"), 1);
    await Promise.resolve();
    expect(sent[0]!.caption).toContain("claude-in-chrome: computer");
    expect(sent[0]!.caption).not.toContain("mcp__");
  });

  test("pasted image (no toolUseId, no text) → 'Pasted image' caption", async () => {
    const state = baseState();
    renderImage({} as any, state, imageEvent("CCCC", "image/png"), 1);
    await Promise.resolve();
    expect(sent[0]!.caption).toContain("Pasted image");
  });

  test("pasted image with text → 'Terminal:' caption from event.content", async () => {
    const state = baseState();
    const e = {
      type: "image",
      content: "testing pasting in terminal",
      image: { mediaType: "image/png", dataBase64: "PP" },
    } as TailEvent;
    renderImage({} as any, state, e, 1);
    await Promise.resolve();
    expect(sent[0]!.caption).toContain("Terminal:");
    expect(sent[0]!.caption).toContain("testing pasting in terminal");
    expect(sent[0]!.caption).not.toContain("Pasted image");
  });

  test("@upload path image → photo via path attachment, text as caption", async () => {
    const state = baseState();
    const e = {
      type: "image",
      content: "look at this meme",
      image: { path: "/Users/x/.claude/uploads/s/IMG_6507.png" },
    } as TailEvent;
    renderImage({} as any, state, e, 1);
    await Promise.resolve();
    expect(sent[0]!.kind).toBe("photo");
    expect(sent[0]!.path).toBe("/Users/x/.claude/uploads/s/IMG_6507.png");
    expect(sent[0]!.hasBytes).toBe(false);
    expect(sent[0]!.caption).toContain("Terminal:");
    expect(sent[0]!.caption).toContain("look at this meme");
  });

  test("byte-identical consecutive frame is skipped", async () => {
    const state = baseState();
    renderImage({} as any, state, imageEvent("DUP", "image/png", "t"), 1);
    renderImage({} as any, state, imageEvent("DUP", "image/png", "t"), 1);
    await Promise.resolve();
    expect(sent).toHaveLength(1);
  });

  test("different frame after a dup is sent", async () => {
    const state = baseState();
    renderImage({} as any, state, imageEvent("ONE", "image/png"), 1);
    renderImage({} as any, state, imageEvent("TWO", "image/png"), 1);
    await Promise.resolve();
    expect(sent).toHaveLength(2);
  });
});
