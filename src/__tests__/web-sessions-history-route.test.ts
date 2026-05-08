import "./ensure-test-env";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";

let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "hist-route-"));
  process.env.CLAUDE_DIR = TMP;
  process.env.WEB_AUTH_BYPASS = "true";
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.CLAUDE_DIR;
  delete process.env.WEB_AUTH_BYPASS;
});

async function buildApp() {
  const { createSessionsRouter } = await import("../web/routes/sessions");
  const app = new Hono();
  app.route("/api/sessions", createSessionsRouter());
  return app;
}

function writeJsonl(sessionId: string, lines: unknown[]): void {
  const projectsDir = join(TMP, "projects", "-p");
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(
    join(projectsDir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

describe("GET /api/sessions/:id/history", () => {
  test("returns empty events when JSONL is missing", async () => {
    const app = await buildApp();
    const res = await app.request("/api/sessions/no-such-session/history");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toEqual([]);
  });

  test("returns history events from a fixture JSONL", async () => {
    const sid = "bbbb1111-2222-3333-4444-555566667777";
    writeJsonl(sid, [
      { type: "user", message: { role: "user", content: "hello from user" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello back" }],
        },
      },
    ]);

    const app = await buildApp();
    const res = await app.request(`/api/sessions/${sid}/history`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ type: string; content: string }>;
    };
    expect(body.events).toHaveLength(2);
    // Native (no channel tag) user message → user_message+terminal
    expect(body.events[0]).toMatchObject({
      type: "user_message",
      content: "hello from user",
    });
    expect(body.events[1]!.type).toBe("text");
  });

  test("caps by limit query parameter", async () => {
    const sid = "cccc1111-2222-3333-4444-555566667777";
    const lines = Array.from({ length: 5 }, (_, i) => ({
      type: "user",
      message: { role: "user", content: `msg${i}` },
    }));
    writeJsonl(sid, lines);

    const app = await buildApp();
    const res = await app.request(`/api/sessions/${sid}/history?limit=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toHaveLength(2);
  });

  test("returns 401 without auth", async () => {
    const savedBypass = process.env.WEB_AUTH_BYPASS;
    delete process.env.WEB_AUTH_BYPASS;
    try {
      const app = await buildApp();
      const res = await app.request("/api/sessions/some-session/history");
      expect(res.status).toBe(401);
    } finally {
      if (savedBypass !== undefined) {
        process.env.WEB_AUTH_BYPASS = savedBypass;
      }
    }
  });
});
