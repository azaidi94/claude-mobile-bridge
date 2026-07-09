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
    // Empty snapshot by default → launchUuidForSessionId returns undefined, so
    // the route falls back to the sessionId lookup (existing behavior).
    const { setCurrentSnapshot } = await import("../sessions/resolve-session");
    setCurrentSnapshot({ aliveRelays: [], topics: [] });
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

  test("two same-dir watches: routes by session_id to the correct sibling", async () => {
    // Two sessions in ONE folder, each with its own watch + topic. The AUQ
    // bridge must route by session_id, not cwd — otherwise the 2nd session's
    // questions land in the 1st session's topic.
    const { _resetWatchesForTests, _registerWatchForTests } =
      await import("../handlers/watch");
    _resetWatchesForTests();
    const base = {
      currentToolMsg: null,
      currentTextMsg: null,
      currentTextContent: "",
      lastTextUpdate: 0,
      segmentDone: true,
      lastEventTime: Date.now(),
      tailer: { stop: () => {} },
    };
    _registerWatchForTests({
      chatId: 100,
      threadId: 42,
      sessionName: "saas",
      sessionId: "id1",
      sessionDir: "/repo/saas",
      ...base,
    } as any);
    _registerWatchForTests({
      chatId: 100,
      threadId: 77,
      sessionName: "saas-2",
      sessionId: "id2",
      sessionDir: "/repo/saas",
      ...base,
    } as any);

    const app = await buildApp();
    const res = await app.request("/api/auq-bridge", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({
        request_id: "auq_sib",
        tool_use_id: "toolu_sib",
        session_id: "id2",
        cwd: "/repo/saas",
        questions: [
          { question: "Q", options: [{ label: "A" }, { label: "B" }] },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threadId: number };
    // Must be the SECOND session's topic, not the first.
    expect(body.threadId).toBe(77);
  });

  test("two same-dir topics (no watch): routes by session_id to the correct sibling", async () => {
    const { _resetWatchesForTests } = await import("../handlers/watch");
    _resetWatchesForTests();
    const { clearTopicStore, setChatId, addTopicMapping } =
      await import("../topics/topic-store");
    clearTopicStore();
    setChatId(-555);
    addTopicMapping({
      topicId: 1001,
      sessionName: "saas",
      sessionDir: "/repo/saas",
      sessionId: "id1",
      isOnline: true,
      createdAt: new Date().toISOString(),
    });
    addTopicMapping({
      topicId: 1002,
      sessionName: "saas-2",
      sessionDir: "/repo/saas",
      sessionId: "id2",
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
        request_id: "auq_sib2",
        tool_use_id: "toolu_sib2",
        session_id: "id2",
        cwd: "/repo/saas",
        questions: [{ question: "Q", options: [{ label: "A" }] }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threadId: number };
    expect(body.threadId).toBe(1002);
  });

  test("routes by launchUuid when the topic's sessionId is stale (post-/clear)", async () => {
    // The session /cleared: its live sessionId is "live-sid" (what the AUQ worker
    // posts), but the topic still carries the pre-clear "old-sid". Keyed on the
    // authoritative registry launchUuid, the route still finds the topic — the
    // sessionId-only lookup would miss and the cwd cross-guard would 404.
    const { _resetWatchesForTests } = await import("../handlers/watch");
    _resetWatchesForTests();
    const { clearTopicStore, setChatId, addTopicMapping } =
      await import("../topics/topic-store");
    clearTopicStore();
    setChatId(-42042);
    addTopicMapping({
      topicId: 3131,
      sessionName: "saas-builder",
      sessionDir: "/repo/saas",
      sessionId: "old-sid", // stale (pre-/clear)
      launchUuid: "LU-1",
      isOnline: true,
      createdAt: new Date().toISOString(),
    });
    const { setCurrentSnapshot } = await import("../sessions/resolve-session");
    setCurrentSnapshot({
      aliveRelays: [],
      topics: [],
      launchUuidBySessionId: new Map([["live-sid", "LU-1"]]),
    });

    const app = await buildApp();
    const res = await app.request("/api/auq-bridge", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({
        request_id: "auq_lu",
        tool_use_id: "toolu_lu",
        session_id: "live-sid",
        cwd: "/repo/saas",
        questions: [{ question: "Q", options: [{ label: "A" }] }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threadId: number; chatId: number };
    expect(body.threadId).toBe(3131);
    expect(body.chatId).toBe(-42042);
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
        session_id: "id1",
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

  test("sibling with no watch does NOT cross-deliver to the other session's watch", async () => {
    // Only session id1 has a watch in /repo/saas. Session id2 (same folder, no
    // watch of its own) posts an AUQ. The id lookup misses; the cwd fallback
    // must NOT hand id2's question to id1's topic — that's the sibling
    // cross-wire this route exists to prevent. Expect 404 (no route for id2)
    // rather than a misroute into id1's chat.
    const app = await buildApp();
    const res = await app.request("/api/auq-bridge", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({
        request_id: "auq_cross",
        tool_use_id: "toolu_cross",
        session_id: "id2",
        cwd: "/repo/saas",
        questions: [{ question: "Q", options: [{ label: "A" }] }],
      }),
    });
    expect(res.status).toBe(404);
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
