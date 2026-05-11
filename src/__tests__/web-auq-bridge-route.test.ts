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
});
