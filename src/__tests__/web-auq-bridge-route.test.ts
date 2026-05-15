import "./ensure-test-env";
import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";

const SECRET = "test-secret-123";

async function buildApp() {
  process.env.RELAY_AUQ_SECRET = SECRET;
  process.env.WEB_AUTH_BYPASS = "true";
  const { createAuqBridgeRouter } = await import("../web/routes/auq-bridge");
  const app = new Hono();
  app.route("/api/auq-bridge", createAuqBridgeRouter());
  return app;
}

describe("POST /api/auq-bridge", () => {
  beforeEach(async () => {
    const { _resetForTests } = await import("../handlers/auq-bridge-registry");
    _resetForTests();
    const { _resetWatchesForTests, _registerWatchForTests } =
      await import("../handlers/watch");
    _resetWatchesForTests();
    const { clearTopicStore } = await import("../topics/topic-store");
    clearTopicStore();
    _registerWatchForTests({
      chatId: 100,
      threadId: 42,
      sessionName: "s1",
      sessionId: "id1",
      sessionDir: "/repo/saas",
      currentToolMsg: null,
      currentTextMsg: null,
      currentTextContent: "",
      lastTextUpdate: 0,
      segmentDone: true,
      lastEventTime: Date.now(),
      tailer: { stop: () => {} },
    } as any);
  });

  test("401 on missing auth", async () => {
    const app = await buildApp();
    const res = await app.request("/api/auq-bridge", {
      method: "POST",
      body: JSON.stringify({
        request_id: "x",
        cwd: "/repo/saas",
        questions: [],
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  test("401 on wrong auth", async () => {
    const app = await buildApp();
    const res = await app.request("/api/auq-bridge", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer nope",
      },
      body: JSON.stringify({
        request_id: "x",
        cwd: "/repo/saas",
        questions: [],
      }),
    });
    expect(res.status).toBe(401);
  });

  test("404 when no watch matches cwd", async () => {
    const app = await buildApp();
    const res = await app.request("/api/auq-bridge", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({
        request_id: "auq_1",
        tool_use_id: "toolu_x",
        session_id: "sid",
        cwd: "/unknown/dir",
        questions: [
          { question: "Q", options: [{ label: "A" }, { label: "B" }] },
        ],
      }),
    });
    expect(res.status).toBe(404);
  });

  test("200 + request_id falls back to topic store when no watch matches", async () => {
    // Group-forum mode: each session has its own topic, so the topic↔sessionDir
    // mapping is the routing key — no active /watch is required for AUQ to
    // reach Telegram.
    const { _resetWatchesForTests } = await import("../handlers/watch");
    _resetWatchesForTests();
    const { clearTopicStore, setChatId, addTopicMapping } =
      await import("../topics/topic-store");
    clearTopicStore();
    setChatId(-100200300);
    addTopicMapping({
      topicId: 9999,
      sessionName: "saas-builder",
      sessionDir: "/repo/saas",
      sessionId: "sid",
      isOnline: true,
      createdAt: new Date().toISOString(),
    });

    const app = await buildApp();
    const res = await app.request("/api/auq-bridge", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({
        request_id: "auq_topic",
        tool_use_id: "toolu_z",
        session_id: "sid",
        cwd: "/repo/saas",
        questions: [{ question: "Q", options: [{ label: "A" }] }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      request_id: string;
      chatId: number;
      threadId: number;
    };
    expect(body.request_id).toBe("auq_topic");
    expect(body.chatId).toBe(-100200300);
    expect(body.threadId).toBe(9999);
  });

  test("200 + request_id when watch matches", async () => {
    const app = await buildApp();
    const res = await app.request("/api/auq-bridge", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({
        request_id: "auq_2",
        tool_use_id: "toolu_y",
        session_id: "sid",
        cwd: "/repo/saas",
        questions: [
          { question: "Q", options: [{ label: "A" }, { label: "B" }] },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { request_id: string; chatId: number };
    expect(body.request_id).toBe("auq_2");
    expect(body.chatId).toBe(100);
  });
});

describe("GET /api/auq-bridge/:id/answer", () => {
  beforeEach(async () => {
    const { _resetForTests } = await import("../handlers/auq-bridge-registry");
    _resetForTests();
  });

  test("returns answer when bridge is resolved", async () => {
    const app = await buildApp();
    const { register, resolve } =
      await import("../handlers/auq-bridge-registry");
    register({
      requestId: "auq_x",
      toolUseId: "t",
      sessionName: "s",
      chatId: 1,
      threadId: 2,
      questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }],
    });
    setTimeout(
      () =>
        resolve("auq_x", {
          status: "answered",
          answers: [{ question: "Q", answer: "A" }],
        }),
      10,
    );

    const res = await app.request("/api/auq-bridge/auq_x/answer", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("answered");
    expect(body.answers[0].answer).toBe("A");
  });

  test("returns 408 when long-poll window elapses", async () => {
    const app = await buildApp();
    const { register } = await import("../handlers/auq-bridge-registry");
    register({
      requestId: "auq_t",
      toolUseId: "t",
      sessionName: "s",
      chatId: 1,
      threadId: 2,
      questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }],
    });
    const res = await app.request("/api/auq-bridge/auq_t/answer?wait_ms=50", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(408);
  });

  test("deletes the registry entry when the long-poll client disconnects", async () => {
    const app = await buildApp();
    const { register, _allForTests } =
      await import("../handlers/auq-bridge-registry");
    register({
      requestId: "auq_abort",
      toolUseId: "t",
      sessionName: "s",
      chatId: 1,
      threadId: 2,
      questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(_allForTests().has("auq_abort")).toBe(true);

    const ac = new AbortController();
    const req = new Request(
      "http://local/api/auq-bridge/auq_abort/answer?wait_ms=2000",
      {
        headers: { Authorization: `Bearer ${SECRET}` },
        signal: ac.signal,
      },
    );
    void Promise.resolve(app.fetch(req)).catch(() => null);
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await new Promise((r) => setTimeout(r, 10));
    expect(_allForTests().has("auq_abort")).toBe(false);
  });

  test("waiters suspended on waitFor() unblock immediately when the entry is deleted", async () => {
    // Regression: deleteEntry must resolve pending waiters so HTTP-poll
    // handlers don't sit on a closed socket until the natural timeout.
    const { register, waitFor, deleteEntry } =
      await import("../handlers/auq-bridge-registry");
    register({
      requestId: "auq_delete_unblock",
      toolUseId: "t",
      sessionName: "s",
      chatId: 1,
      threadId: 2,
      questions: [{ question: "Q", options: [{ label: "A" }, { label: "B" }] }],
    });

    const start = Date.now();
    const pending = waitFor("auq_delete_unblock", 10_000);
    // Give the waiter a tick to register, then delete.
    await new Promise((r) => setTimeout(r, 5));
    deleteEntry("auq_delete_unblock");
    const result = await pending;
    const elapsed = Date.now() - start;
    expect(result.status).toBe("cancelled");
    if (result.status === "cancelled") expect(result.reason).toBe("deleted");
    expect(elapsed).toBeLessThan(500); // not waiting 10s — unblocked promptly
  });
});
