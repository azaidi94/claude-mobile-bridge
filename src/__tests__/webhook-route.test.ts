import { describe, it, expect, beforeEach, mock } from "bun:test";

// Mock config BEFORE importing the route — the route reads WEBHOOK_SECRET
// at import time via a top-level binding.
mock.module("../config", () => ({
  WEBHOOK_SECRET: "test-secret",
  TELEGRAM_TOKEN: "test-token",
  ALLOWED_USERS: [1],
}));

interface BusCall {
  chatId: number;
  threadId: number | undefined;
  content: string;
}
const busCalls: BusCall[] = [];

mock.module("../messaging", () => ({
  getMessageBus: () => ({
    send: async (opts: BusCall) => {
      busCalls.push(opts);
      return { messageId: 1 };
    },
  }),
}));

const topicStore = {
  chatId: -100123,
  topics: [] as Array<{ sessionName: string; topicId: number }>,
};
mock.module("../topics", () => ({
  getTopicStore: () => topicStore,
  getTopicBySession: (name: string) =>
    topicStore.topics.find((t) => t.sessionName === name),
}));

const { createWebhookRouter } = await import("../web/routes/webhook");

function makeReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/webhook/notify", () => {
  beforeEach(() => {
    busCalls.length = 0;
    topicStore.chatId = -100123;
    topicStore.topics = [{ sessionName: "my-proj", topicId: 5050 }];
  });

  it("401 without bearer", async () => {
    const app = createWebhookRouter();
    const res = await app.fetch(makeReq({ text: "hi" }));
    expect(res.status).toBe(401);
  });

  it("401 with wrong bearer", async () => {
    const app = createWebhookRouter();
    const res = await app.fetch(
      makeReq({ text: "hi" }, { Authorization: "Bearer wrong" }),
    );
    expect(res.status).toBe(401);
  });

  it("400 without text", async () => {
    const app = createWebhookRouter();
    const res = await app.fetch(
      makeReq({}, { Authorization: "Bearer test-secret" }),
    );
    expect(res.status).toBe(400);
  });

  it("delivers by session name", async () => {
    const app = createWebhookRouter();
    const res = await app.fetch(
      makeReq(
        { session: "my-proj", text: "deploy green" },
        { Authorization: "Bearer test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    expect(busCalls).toHaveLength(1);
    expect(busCalls[0]?.chatId).toBe(-100123);
    expect(busCalls[0]?.threadId).toBe(5050);
    expect(busCalls[0]?.content).toContain("deploy green");
  });

  it("delivers by direct topicId", async () => {
    const app = createWebhookRouter();
    const res = await app.fetch(
      makeReq(
        { topicId: 999, text: "raw" },
        { Authorization: "Bearer test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    expect(busCalls[0]?.threadId).toBe(999);
  });

  it("prepends source label as HTML when provided", async () => {
    const app = createWebhookRouter();
    await app.fetch(
      makeReq(
        { session: "my-proj", text: "build passed", source: "CI/main" },
        { Authorization: "Bearer test-secret" },
      ),
    );
    expect(busCalls[0]?.content).toContain("🪝 <b>CI/main:</b>");
  });

  it("escapes HTML in source label", async () => {
    const app = createWebhookRouter();
    await app.fetch(
      makeReq(
        { session: "my-proj", text: "x", source: "<script>" },
        { Authorization: "Bearer test-secret" },
      ),
    );
    expect(busCalls[0]?.content).toContain("&lt;script&gt;");
  });

  it("404 for unknown session", async () => {
    const app = createWebhookRouter();
    const res = await app.fetch(
      makeReq(
        { session: "nope", text: "x" },
        { Authorization: "Bearer test-secret" },
      ),
    );
    expect(res.status).toBe(404);
  });

  it("503 when no chat registered", async () => {
    topicStore.chatId = 0;
    const app = createWebhookRouter();
    const res = await app.fetch(
      makeReq(
        { topicId: 5, text: "x" },
        { Authorization: "Bearer test-secret" },
      ),
    );
    expect(res.status).toBe(503);
  });
});
