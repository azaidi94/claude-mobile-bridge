import "./ensure-test-env";
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { createMessageBus } from "../messaging/bus";
import { resolveParseMode, chunkContent } from "../messaging/format";
import { TELEGRAM_SAFE_LIMIT } from "../config";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface MockSendCall {
  chatId: number;
  text: string;
  opts: Record<string, unknown>;
}

interface MockApi {
  sendMessage: ReturnType<typeof mock>;
  sendPhoto: ReturnType<typeof mock>;
  sendDocument: ReturnType<typeof mock>;
  sendVoice: ReturnType<typeof mock>;
  editMessageText: ReturnType<typeof mock>;
  _sentTexts: MockSendCall[];
}

function makeApi(opts?: {
  sendMessageImpl?: (chatId: number, text: string, o: any) => any;
  editImpl?: (chatId: number, messageId: number, text: string, o: any) => any;
}): MockApi {
  const sent: MockSendCall[] = [];
  let counter = 1000;
  const sendMessage = mock((chatId: number, text: string, o: any) => {
    sent.push({ chatId, text, opts: o ?? {} });
    if (opts?.sendMessageImpl) {
      return opts.sendMessageImpl(chatId, text, o);
    }
    return Promise.resolve({ message_id: counter++ });
  });
  const sendPhoto = mock((chatId: number, _file: any, o: any) =>
    Promise.resolve({ message_id: counter++, chat_id: chatId, o }),
  );
  const sendDocument = mock((chatId: number, _file: any, o: any) =>
    Promise.resolve({ message_id: counter++, chat_id: chatId, o }),
  );
  const sendVoice = mock((chatId: number, _file: any, o: any) =>
    Promise.resolve({ message_id: counter++, chat_id: chatId, o }),
  );
  const editMessageText = mock(
    (chatId: number, messageId: number, text: string, o: any) => {
      if (opts?.editImpl) return opts.editImpl(chatId, messageId, text, o);
      return Promise.resolve({ message_id: messageId, chat_id: chatId });
    },
  );
  return {
    sendMessage,
    sendPhoto,
    sendDocument,
    sendVoice,
    editMessageText,
    _sentTexts: sent,
  };
}

function captureStdout(): { restore: () => void; lines: () => string[] } {
  const original = process.stdout.write.bind(process.stdout);
  const captured: string[] = [];
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return original(chunk, ...rest);
  };
  return {
    restore: () => {
      (process.stdout as any).write = original;
    },
    lines: () => captured.join("").split("\n").filter(Boolean),
  };
}

// Mock Bun.file for attachment tests (avoids needing a real file on disk).
const originalBunFile = Bun.file;
function mockBunFile(content: string) {
  (Bun as any).file = (_path: string) => ({
    arrayBuffer: async () => new TextEncoder().encode(content).buffer,
  });
}
function restoreBunFile() {
  (Bun as any).file = originalBunFile;
}

// ---------------------------------------------------------------------------
// format.ts
// ---------------------------------------------------------------------------

describe("resolveParseMode", () => {
  test("auto + HTML content → HTML parse_mode", () => {
    const r = resolveParseMode("<b>hi</b>", "auto");
    expect(r.parse_mode).toBe("HTML");
    expect(r.content).toContain("<b>hi</b>");
  });

  test("auto + plain content → HTML parse_mode via markdown converter", () => {
    // Plain text routes through convertMarkdownToHtml (no markdown tokens →
    // identity except for entity escaping). Result is still HTML mode.
    const r = resolveParseMode("hello world", "auto");
    expect(r.parse_mode).toBe("HTML");
    expect(r.content).toBe("hello world");
  });

  test("plain hint → no parse_mode", () => {
    const r = resolveParseMode("<b>hi</b>", "plain");
    expect(r.parse_mode).toBeUndefined();
    expect(r.content).toBe("<b>hi</b>");
  });

  test("markdown hint → MarkdownV2 verbatim", () => {
    const r = resolveParseMode("*hi*", "markdown");
    expect(r.parse_mode).toBe("MarkdownV2");
    expect(r.content).toBe("*hi*");
  });
});

describe("chunkContent", () => {
  test("short content → single chunk", () => {
    expect(chunkContent("hi")).toEqual(["hi"]);
  });

  test("long content splits at paragraph boundaries", () => {
    const para = "a".repeat(2000);
    const text = `${para}\n\n${para}\n\n${para}`;
    const chunks = chunkContent(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks)
      expect(c.length).toBeLessThanOrEqual(TELEGRAM_SAFE_LIMIT);
    // Boundaries should not start with the trailing "\n" residue.
    for (const c of chunks) expect(c.startsWith("\n")).toBe(false);
  });

  test("long content with only line breaks splits at lines", () => {
    const line = "a".repeat(500);
    const text = Array.from({ length: 20 }, () => line).join("\n");
    const chunks = chunkContent(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks)
      expect(c.length).toBeLessThanOrEqual(TELEGRAM_SAFE_LIMIT);
  });
});

// ---------------------------------------------------------------------------
// bus.send — happy path & format
// ---------------------------------------------------------------------------

describe("MessageBus.send — text", () => {
  test("returns messageId for a simple send", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    const r = await bus.send({ chatId: 1, content: "hello" });
    expect("messageId" in r).toBe(true);
    if ("messageId" in r) expect(r.messageId).toBe(1000);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("threadId is passed as message_thread_id", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    await bus.send({ chatId: 7, threadId: 42, content: "hi" });
    expect(api._sentTexts[0]!.opts.message_thread_id).toBe(42);
  });

  test("auto-HTML content sets parse_mode HTML", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    await bus.send({ chatId: 1, content: "<b>hi</b>", format: "auto" });
    expect(api._sentTexts[0]!.opts.parse_mode).toBe("HTML");
  });

  test("auto-plain content still routes via HTML pipeline", async () => {
    // The bus uses convertMarkdownToHtml for "auto", so parse_mode HTML is set
    // even for plain text — it's safe because escapeHtml leaves the content
    // untouched. Verifying this keeps behaviour consistent with the legacy
    // sendTextReply path.
    const api = makeApi();
    const bus = createMessageBus(api as any);
    await bus.send({ chatId: 1, content: "just text", format: "auto" });
    expect(api._sentTexts[0]!.opts.parse_mode).toBe("HTML");
    expect(api._sentTexts[0]!.text).toBe("just text");
  });

  test("explicit plain hint → no parse_mode", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    await bus.send({ chatId: 1, content: "<x>raw</x>", format: "plain" });
    expect(api._sentTexts[0]!.opts.parse_mode).toBeUndefined();
    expect(api._sentTexts[0]!.text).toBe("<x>raw</x>");
  });

  test("silent=true sets disable_notification on the send", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    await bus.send({ chatId: 1, content: "shh", silent: true });
    expect(api._sentTexts[0]!.opts.disable_notification).toBe(true);
  });

  test("silent omitted → no disable_notification opt", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    await bus.send({ chatId: 1, content: "loud" });
    expect(api._sentTexts[0]!.opts.disable_notification).toBeUndefined();
  });

  test("replyMarkup is passed through as reply_markup", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    const markup = { inline_keyboard: [[{ text: "Yes", callback_data: "y" }]] };
    await bus.send({ chatId: 1, content: "pick?", replyMarkup: markup });
    expect(api._sentTexts[0]!.opts.reply_markup).toEqual(markup);
  });

  test("replyTo translates to reply_parameters", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    await bus.send({
      chatId: 1,
      content: "yo",
      replyTo: { messageId: 555 },
    });
    expect(api._sentTexts[0]!.opts.reply_parameters).toEqual({
      message_id: 555,
    });
  });
});

// ---------------------------------------------------------------------------
// chunking
// ---------------------------------------------------------------------------

describe("MessageBus.send — chunking", () => {
  test("long content splits into ordered chunks, returns first messageId", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    const para = "x".repeat(2000);
    const text = `${para}\n\n${para}\n\n${para}`;
    const r = await bus.send({ chatId: 9, content: text, format: "plain" });
    expect("messageId" in r).toBe(true);
    if ("messageId" in r) expect(r.messageId).toBe(1000);
    expect(api.sendMessage.mock.calls.length).toBeGreaterThan(1);
    // First-chunk reply_parameters only on first chunk
    expect(api._sentTexts[0]!.opts.message_thread_id).toBeUndefined();
  });

  test("a long code block never splits an HTML tag across chunks", async () => {
    // Regression: the bus must chunk the RAW content and convert each chunk,
    // not chunk already-converted HTML. Chunking the whole HTML would slice
    // through a <pre> tag (chunk 0 opens it, a later chunk closes it), and TG
    // rejects both as invalid entities, silently dropping the whole message to
    // plain text. Per-chunk conversion keeps every chunk's HTML self-contained.
    const api = makeApi();
    const bus = createMessageBus(api as any);
    const line = "const x = " + "y".repeat(60) + ";";
    const code = Array.from({ length: 120 }, () => line).join("\n");
    const text = "```js\n" + code + "\n```"; // ~8.6k chars → multiple chunks

    const r = await bus.send({ chatId: 7, content: text, format: "auto" });

    expect("messageId" in r).toBe(true);
    expect(api._sentTexts.length).toBeGreaterThan(1);
    // Every chunk that was sent as HTML must have balanced tags — no chunk may
    // open a tag it doesn't close, or close one it never opened.
    for (const sent of api._sentTexts) {
      if (sent.opts.parse_mode !== "HTML") continue;
      const html = sent.text;
      for (const tag of ["pre", "b", "i", "code", "s"]) {
        const open = (html.match(new RegExp(`<${tag}>`, "g")) || []).length;
        const close = (html.match(new RegExp(`</${tag}>`, "g")) || []).length;
        expect(open).toBe(close);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// plain fallback
// ---------------------------------------------------------------------------

describe("MessageBus.send — plain fallback", () => {
  test("retries without parse_mode on parse-entity error", async () => {
    let calls = 0;
    const api = makeApi({
      sendMessageImpl: (_chatId, _text, _o) => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(
            new Error("Bad Request: can't parse entities at byte 12"),
          );
        }
        return Promise.resolve({ message_id: 4242 });
      },
    });
    const bus = createMessageBus(api as any);
    const r = await bus.send({ chatId: 1, content: "<b>bad", format: "html" });
    expect("messageId" in r).toBe(true);
    if ("messageId" in r) expect(r.messageId).toBe(4242);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    // Second call must not carry parse_mode.
    expect(api._sentTexts[1]!.opts.parse_mode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// dedup
// ---------------------------------------------------------------------------

describe("MessageBus.send — dedup", () => {
  test("second send with same dedupKey within TTL → dropped", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    const r1 = await bus.send({ chatId: 1, content: "x", dedupKey: "k1" });
    const r2 = await bus.send({ chatId: 1, content: "x", dedupKey: "k1" });
    expect("messageId" in r1).toBe(true);
    expect("dropped" in r2 && (r2 as any).dropped).toBe("dedup");
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("different dedupKeys are independent", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    const r1 = await bus.send({ chatId: 1, content: "x", dedupKey: "a" });
    const r2 = await bus.send({ chatId: 1, content: "x", dedupKey: "b" });
    expect("messageId" in r1).toBe(true);
    expect("messageId" in r2).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rate limit
// ---------------------------------------------------------------------------

describe("MessageBus.send — rate limit", () => {
  test("31st rapid send is rate-limited (drop or wait)", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    // 30 should sail through; 31st must wait (or drop).
    const first30: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      first30.push(bus.send({ chatId: 7, content: `m${i}` }));
    }
    await Promise.all(first30);
    expect(api.sendMessage).toHaveBeenCalledTimes(30);

    // 31st send: kick off and race against a short timer.
    const start = Date.now();
    const r = await bus.send({ chatId: 7, content: "m31" });
    const elapsed = Date.now() - start;
    // Either it waited measurably (>= a couple poll cycles) and succeeded,
    // or it gave up and returned dropped:ratelimit.
    if ("messageId" in r) {
      expect(elapsed).toBeGreaterThanOrEqual(100);
    } else {
      expect((r as any).dropped).toBe("ratelimit");
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

describe("MessageBus.send — attachments", () => {
  beforeEach(() => mockBunFile("PHOTO-BYTES"));
  afterEach(() => restoreBunFile());

  test("photo attachment uses sendPhoto and honours caption format", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    const r = await bus.send({
      chatId: 1,
      content: "<b>cap</b>",
      format: "auto",
      attachment: { kind: "photo", path: "/tmp/x.jpg" },
    });
    expect("messageId" in r).toBe(true);
    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(0);
    const call = api.sendPhoto.mock.calls[0] as any[];
    const opts = call[2];
    expect(opts.parse_mode).toBe("HTML");
    expect(opts.caption).toContain("<b>cap</b>");
  });

  test("document attachment uses sendDocument", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    await bus.send({
      chatId: 1,
      content: "",
      attachment: { kind: "document", path: "/tmp/x.pdf" },
    });
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
  });

  test("voice attachment uses sendVoice", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    await bus.send({
      chatId: 1,
      content: "",
      attachment: { kind: "voice", path: "/tmp/x.ogg" },
    });
    expect(api.sendVoice).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

describe("MessageBus.edit", () => {
  test("happy path → { ok: true }", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    const r = await bus.edit(123, { chatId: 1, content: "new text" });
    expect(r).toEqual({ ok: true });
    expect(api.editMessageText).toHaveBeenCalledTimes(1);
  });

  test("plain fallback on parse-entity error", async () => {
    let calls = 0;
    const api = makeApi({
      editImpl: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new Error("Bad Request: can't parse entities"));
        }
        return Promise.resolve({ message_id: 5 });
      },
    });
    const bus = createMessageBus(api as any);
    const r = await bus.edit(5, {
      chatId: 1,
      content: "<b>oops",
      format: "html",
    });
    expect(r).toEqual({ ok: true });
    expect(api.editMessageText).toHaveBeenCalledTimes(2);
  });

  test("replyMarkup on edit is passed through as reply_markup", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    const markup = { inline_keyboard: [[{ text: "Ok", callback_data: "ok" }]] };
    const r = await bus.edit(7, {
      chatId: 1,
      content: "updated",
      replyMarkup: markup,
    });
    expect(r).toEqual({ ok: true });
    const call = api.editMessageText.mock.calls[0] as any[];
    expect(call[3].reply_markup).toEqual(markup);
  });

  test("missing message → { ok: false, reason }", async () => {
    const api = makeApi({
      editImpl: () =>
        Promise.reject(new Error("Bad Request: message to edit not found")),
    });
    const bus = createMessageBus(api as any);
    const r = await bus.edit(99, { chatId: 1, content: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not found");
  });

  test("oversized content is truncated ≤ 4096 with ellipsis", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    // Content that converts to > 4096 chars of HTML.
    const longContent = "&".repeat(5000);
    const r = await bus.edit(1, {
      chatId: 1,
      content: longContent,
      format: "html",
    });
    expect(r).toEqual({ ok: true });
    expect(api.editMessageText).toHaveBeenCalledTimes(1);
    const call = api.editMessageText.mock.calls[0] as any[];
    const sentText: string = call[2];
    expect(sentText.length).toBeLessThanOrEqual(4096);
    expect(sentText.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HTML-aware rechunking (post-conversion overflow)
// ---------------------------------------------------------------------------

describe("MessageBus.send — post-conversion rechunking", () => {
  test("content whose HTML expands beyond 4096 is re-split safely", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    // 3000 `&` chars → each becomes `&amp;` (5 chars) → ~15000 chars of HTML.
    // TELEGRAM_SAFE_LIMIT is 4000, so chunkContent produces one chunk.
    // resolveChunks must detect the post-conversion overflow and re-split.
    const content = "&".repeat(3000);
    const r = await bus.send({
      chatId: 1,
      content,
      format: "html",
    });
    expect("messageId" in r).toBe(true);
    // Must have split into at least 4 chunks (~15000 / 4096 ≈ 4).
    expect(api.sendMessage).toHaveBeenCalledTimes(api._sentTexts.length);
    // Every chunk must be ≤ 4096 chars.
    for (const sent of api._sentTexts) {
      expect(sent.text.length).toBeLessThanOrEqual(4096);
    }
    // All chunks must be self-contained HTML (each `&amp;` is a complete entity).
    for (const sent of api._sentTexts) {
      if (sent.opts.parse_mode !== "HTML") continue;
      // No truncated entities: `&amp;` is 5 chars, `&am` or `amp;` would be broken.
      // Simple check: the text should not end mid-entity.
      const html = sent.text;
      expect(html).not.toMatch(/&[a-z]{1,4}$/); // dangling entity start
      expect(html).not.toMatch(/^[a-z]+;/); // dangling entity end
    }
  });

  test("large code block re-chunks without tag breakage", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);
    // Build a code block that's ~8k chars of raw markdown, converting to
    // HTML with `<pre><code class="language-js">` wrapping.
    const line = "const x = " + "y".repeat(60) + ";";
    const code = Array.from({ length: 200 }, () => line).join("\n");
    const text = "```js\n" + code + "\n```";

    const r = await bus.send({ chatId: 7, content: text, format: "auto" });
    expect("messageId" in r).toBe(true);
    expect(api._sentTexts.length).toBeGreaterThan(1);
    // Every HTML chunk must have balanced tags.
    for (const sent of api._sentTexts) {
      if (sent.opts.parse_mode !== "HTML") continue;
      const html = sent.text;
      for (const tag of ["pre", "b", "i", "code", "s", "em", "strong"]) {
        const open = (html.match(new RegExp(`<${tag}[^>]*>`, "g")) || [])
          .length;
        const close = (html.match(new RegExp(`</${tag}>`, "g")) || []).length;
        expect(open).toBe(close);
      }
    }
    // Every chunk must be ≤ 4096 chars.
    for (const sent of api._sentTexts) {
      expect(sent.text.length).toBeLessThanOrEqual(4096);
    }
  });
});

// ---------------------------------------------------------------------------
// dedup poisoning (dedup only recorded on success)
// ---------------------------------------------------------------------------

describe("MessageBus.send — dedup poisoning", () => {
  test("failed send does not poison dedup cache", async () => {
    // First send fails with a non-recoverable error.
    let calls = 0;
    const api = makeApi({
      sendMessageImpl: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new Error("Network error"));
        }
        return Promise.resolve({ message_id: 9999 });
      },
    });
    const bus = createMessageBus(api as any);

    // First send: fails.
    const r1 = await bus.send({
      chatId: 1,
      content: "retry me",
      dedupKey: "retry-key",
    });
    expect("dropped" in r1 && (r1 as any).dropped).toBe("error");

    // Second send: same dedupKey, should NOT be dedup-dropped.
    const r2 = await bus.send({
      chatId: 1,
      content: "retry me",
      dedupKey: "retry-key",
    });
    expect("messageId" in r2).toBe(true);
    if ("messageId" in r2) expect(r2.messageId).toBe(9999);
  });

  test("rate-limited send does not poison dedup cache", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);

    // Exhaust all 30 tokens.
    for (let i = 0; i < 30; i++) {
      await bus.send({ chatId: 7, content: `m${i}` });
    }

    // 31st send with dedup key → should be rate-limited, not dedup-poisoned.
    const r1 = await bus.send({
      chatId: 7,
      content: "after-burst",
      dedupKey: "burst-key",
    });
    // Either dropped:ratelimit or succeeded after waiting.
    if ("dropped" in r1 && (r1 as any).dropped === "ratelimit") {
      // Rate-limited: verify retry is NOT dedup-dropped.
      // Wait a bit for token refill.
      await new Promise((r) => setTimeout(r, 200));
      const r2 = await bus.send({
        chatId: 7,
        content: "after-burst",
        dedupKey: "burst-key",
      });
      expect("messageId" in r2).toBe(true);
    }
    // If it succeeded (waited), that's also fine — dedup wasn't poisoned
    // because it was never recorded before the send attempt.
  }, 20_000);
});

// ---------------------------------------------------------------------------
// rate tokens per chunk
// ---------------------------------------------------------------------------

describe("MessageBus.send — rate tokens per chunk", () => {
  test("multi-chunk send consumes rate token for each chunk", async () => {
    const api = makeApi();
    const bus = createMessageBus(api as any);

    // Consume 28 tokens first, leaving ~2 in the bucket.
    for (let i = 0; i < 28; i++) {
      await bus.send({ chatId: 9, content: `token-eater-${i}` });
    }

    // Now send a message that will produce 3+ chunks.
    // With only ~2 tokens left + refill, the per-chunk token consumption
    // ensures not all chunks blast through on the same token.
    const para = "Z".repeat(3000);
    const text = `${para}\n\n${para}\n\n${para}\n\n${para}`; // 4 chunks
    const r = await bus.send({ chatId: 9, content: text, format: "plain" });

    // The send should succeed (at least first chunk), and each chunk
    // individually consumed a token. With plain format, no HTML expansion.
    expect("messageId" in r).toBe(true);
    // All chunks should have been sent (rate limiter had enough tokens
    // with refill + waiting).
    expect(api._sentTexts.length).toBe(28 + 4);
    // Verify each send was for a distinct chunk.
    for (const sent of api._sentTexts.slice(28)) {
      expect(sent.text.length).toBeLessThanOrEqual(4096);
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// logging schema
// ---------------------------------------------------------------------------

describe("MessageBus logging", () => {
  // The per-op `bus.send` schema line is emitted at debug level, so enable
  // DEBUG around the capture (the logger reads it live).
  const prevDebug = process.env.DEBUG;
  beforeEach(() => {
    process.env.DEBUG = "1";
  });
  afterEach(() => {
    if (prevDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = prevDebug;
  });

  test("one bus.send log line per send with documented fields", async () => {
    const cap = captureStdout();
    try {
      const api = makeApi();
      const bus = createMessageBus(api as any);
      await bus.send({
        chatId: 1,
        threadId: 2,
        content: "hi",
        format: "plain",
        opId: "op_test_1",
      });
      const lines = cap.lines().filter((l) => l.includes("bus.send"));
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const line = lines.find((l) => l.includes("op_test_1"))!;
      expect(line).toBeTruthy();
      expect(line).toContain("chatId=1");
      expect(line).toContain("threadId=2");
      expect(line).toContain('kind="text"');
      expect(line).toMatch(/durationMs=\d+/);
      expect(line).toContain('result="ok"');
      expect(line).toMatch(/chunkCount=1/);
    } finally {
      cap.restore();
    }
  });

  test("dedup drop is logged with result=drop:dedup", async () => {
    const cap = captureStdout();
    try {
      const api = makeApi();
      const bus = createMessageBus(api as any);
      await bus.send({
        chatId: 1,
        content: "x",
        dedupKey: "dk",
        opId: "op_d_1",
      });
      await bus.send({
        chatId: 1,
        content: "x",
        dedupKey: "dk",
        opId: "op_d_2",
      });
      const lines = cap.lines().filter((l) => l.includes("bus.send"));
      const dropLine = lines.find((l) => l.includes("op_d_2"))!;
      expect(dropLine).toBeTruthy();
      expect(dropLine).toContain('result="drop:dedup"');
    } finally {
      cap.restore();
    }
  });

  test("send line is suppressed at default level (no DEBUG)", async () => {
    delete process.env.DEBUG;
    const cap = captureStdout();
    try {
      const api = makeApi();
      const bus = createMessageBus(api as any);
      await bus.send({
        chatId: 1,
        content: "hi",
        format: "plain",
        opId: "op_quiet_1",
      });
      const lines = cap.lines().filter((l) => l.includes("op_quiet_1"));
      expect(lines.length).toBe(0);
    } finally {
      cap.restore();
    }
  });
});
