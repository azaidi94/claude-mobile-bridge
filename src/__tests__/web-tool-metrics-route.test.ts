/**
 * Route tests for GET /api/sessions/:id/tool-metrics.
 */

import "./ensure-test-env";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { recordToolMetric, _resetForTests } from "../sessions/tool-metrics";

beforeEach(() => {
  _resetForTests();
  process.env.WEB_AUTH_BYPASS = "true";
});

afterEach(() => {
  _resetForTests();
  delete process.env.WEB_AUTH_BYPASS;
});

async function buildApp() {
  const { createSessionsRouter } = await import("../web/routes/sessions");
  const app = new Hono();
  app.route("/api/sessions", createSessionsRouter());
  return app;
}

describe("GET /api/sessions/:id/tool-metrics", () => {
  test("returns empty tools array for an unknown session", async () => {
    const app = await buildApp();
    const res = await app.request("/api/sessions/no-such-session/tool-metrics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      windowMs: number;
      tools: unknown[];
    };
    expect(body.sessionId).toBe("no-such-session");
    expect(body.tools).toEqual([]);
    expect(body.windowMs).toBe(60 * 60 * 1000);
  });

  test("returns aggregated metrics for a session", async () => {
    const sid = "metrics-sess-1";
    recordToolMetric(sid, {
      toolName: "Bash",
      durationMs: 100,
      isError: false,
    });
    recordToolMetric(sid, {
      toolName: "Bash",
      durationMs: 300,
      isError: true,
    });
    recordToolMetric(sid, {
      toolName: "Read",
      durationMs: 10,
      isError: false,
    });

    const app = await buildApp();
    const res = await app.request(`/api/sessions/${sid}/tool-metrics`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      tools: Array<{
        toolName: string;
        count: number;
        p50Ms: number;
        p95Ms: number;
        errorPct: number;
        lastSeenMs: number;
      }>;
    };
    expect(body.sessionId).toBe(sid);
    expect(body.tools).toHaveLength(2);
    // Sorted by p95 desc → Bash (p95=300) comes before Read (p95=10).
    expect(body.tools[0]!.toolName).toBe("Bash");
    expect(body.tools[0]!.count).toBe(2);
    expect(body.tools[0]!.errorPct).toBeCloseTo(50, 0);
    expect(body.tools[1]!.toolName).toBe("Read");
  });

  test("clamps the window query param to 24h", async () => {
    const app = await buildApp();
    const res = await app.request(
      "/api/sessions/anything/tool-metrics?window=999999999999",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { windowMs: number };
    expect(body.windowMs).toBe(24 * 60 * 60 * 1000);
  });

  test("falls back to default window for invalid query", async () => {
    const app = await buildApp();
    const res = await app.request(
      "/api/sessions/anything/tool-metrics?window=not-a-number",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { windowMs: number };
    expect(body.windowMs).toBe(60 * 60 * 1000);
  });

  test("returns 401 without auth", async () => {
    delete process.env.WEB_AUTH_BYPASS;
    const app = await buildApp();
    const res = await app.request("/api/sessions/x/tool-metrics");
    expect(res.status).toBe(401);
  });
});
