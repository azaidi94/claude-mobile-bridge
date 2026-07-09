import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";

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

// getSession is mocked per-test; webhook.ts only pulls `getSession` out of
// "../../sessions", so this narrow mock is safe.
const sessionsByName = new Map<string, { pid?: number }>();
mock.module("../sessions", () => ({
  getSession: (n: string) => sessionsByName.get(n) ?? null,
}));

const { createWebhookRouter } = await import("../web/routes/webhook");
const { clearTopicStore, setChatId, addTopicMapping } =
  await import("../topics/topic-store");
const { setCurrentSnapshot } = await import("../sessions/resolve-session");

let testDir: string;

function makeReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/webhook/notify", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "webhook-route-"));
    process.env.CLAUDE_TELEGRAM_TOPICS_FILE = join(testDir, "topics.json");
    busCalls.length = 0;
    sessionsByName.clear();
    clearTopicStore();
    setChatId(-100123);
    addTopicMapping({
      sessionName: "my-proj",
      topicId: 5050,
      sessionDir: "/tmp/my-proj",
      isOnline: true,
      createdAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CLAUDE_TELEGRAM_TOPICS_FILE;
    clearTopicStore();
    setCurrentSnapshot({ aliveRelays: [], topics: [] });
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
    clearTopicStore();
    const app = createWebhookRouter();
    const res = await app.fetch(
      makeReq(
        { topicId: 5, text: "x" },
        { Authorization: "Bearer test-secret" },
      ),
    );
    expect(res.status).toBe(503);
  });

  it("resolves the topic via launchUuid when the session is live, even if the name maps elsewhere", async () => {
    // A different topic claims launchUuid "U1" under a different session
    // name — a name-only lookup for "my-proj" would land on topicId 5050
    // (seeded in beforeEach) instead.
    addTopicMapping({
      sessionName: "other",
      topicId: 77,
      sessionDir: "/tmp/other",
      isOnline: true,
      createdAt: new Date().toISOString(),
      launchUuid: "U1",
    });

    const PID = 4242;
    sessionsByName.set("my-proj", { pid: PID });
    setCurrentSnapshot({
      aliveRelays: [],
      topics: [],
      launchUuidByPid: new Map([[PID, "U1"]]),
    });

    const app = createWebhookRouter();
    const res = await app.fetch(
      makeReq(
        { session: "my-proj", text: "deploy green" },
        { Authorization: "Bearer test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    expect(busCalls[0]?.threadId).toBe(77);
  });
});
