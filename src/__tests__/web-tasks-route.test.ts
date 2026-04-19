import "./ensure-test-env";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";

let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "tasks-route-"));
  process.env.CLAUDE_DIR = TMP;
  process.env.WEB_AUTH_BYPASS = "true";
});

afterEach(async () => {
  const { __resetForTests } = await import("../web/tasks/watcher");
  await __resetForTests();
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.CLAUDE_DIR;
  delete process.env.WEB_AUTH_BYPASS;
});

async function buildApp() {
  const { createTasksRouter } = await import("../web/routes/tasks");
  const app = new Hono();
  app.route("/api/tasks", createTasksRouter());
  return app;
}

describe("GET /api/tasks", () => {
  test("returns empty snapshot when tasks dir is missing", async () => {
    const app = await buildApp();
    const res = await app.request("/api/tasks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ sessions: [], tasks: [] });
  });

  test("returns sessions + tasks from fixture", async () => {
    const sid = "iiii1111-2222-3333-4444-555566667777";
    const d = join(TMP, "tasks", sid);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "a",
        description: "",
        activeForm: "",
        status: "pending",
        blocks: [],
        blockedBy: [],
      }),
    );

    const app = await buildApp();
    const res = await app.request("/api/tasks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{ id: string }>;
      tasks: Array<{ subject: string }>;
    };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.id).toBe(sid);
    expect(body.tasks.map((t) => t.subject)).toEqual(["a"]);
  });
});

describe("GET /api/tasks/stream", () => {
  test("opens an SSE stream with content-type text/event-stream", async () => {
    const app = await buildApp();
    const res = await app.request("/api/tasks/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    // cancel to let watcher tear down cleanly
    await res.body?.cancel();
  });
});
