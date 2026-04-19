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

function waitFor<T>(check: () => T | undefined, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const i = setInterval(() => {
      const v = check();
      if (v !== undefined) {
        clearInterval(i);
        resolve(v);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(i);
        reject(new Error("timeout waiting for condition"));
      }
    }, 25);
  });
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

  test("emits task.upsert when a task file is written", async () => {
    const app = await buildApp();

    const res = await app.request("/api/tasks/stream", {
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();

    const events: string[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Consume chunks in background
    const consuming = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          for (const line of text.split("\n")) {
            if (line.startsWith("data:")) {
              events.push(line.slice("data:".length).trim());
            }
          }
        }
      } catch {
        // aborted — expected
      }
    })();

    // Wait for chokidar to be ready before writing
    const { ready } = await import("../web/tasks/watcher");
    await ready(TMP);

    const sid = "aaaa1111-2222-3333-4444-555566667777";
    const sDir = join(TMP, "tasks", sid);
    mkdirSync(sDir, { recursive: true });
    writeFileSync(
      join(sDir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "stream test",
        description: "",
        activeForm: "",
        status: "pending",
        blocks: [],
        blockedBy: [],
      }),
    );

    // Poll until a task.upsert event for our session appears
    const parsed = await waitFor(() => {
      for (const raw of events) {
        try {
          const evt = JSON.parse(raw) as {
            type: string;
            sessionId: string;
            task?: { subject: string; id: string; sessionId: string };
          };
          if (evt.type === "task.upsert" && evt.sessionId === sid) return evt;
        } catch {
          // skip malformed
        }
      }
      return undefined;
    }, 2000);

    expect(parsed.type).toBe("task.upsert");
    expect(parsed.sessionId).toBe(sid);
    expect(parsed.task!.subject).toBe("stream test");
    expect(parsed.task!.id).toBe("1");

    reader.cancel();
    await consuming;
  });
});

describe("auth rejection", () => {
  test("/api/tasks returns 401 without auth", async () => {
    const savedBypass = process.env.WEB_AUTH_BYPASS;
    delete process.env.WEB_AUTH_BYPASS;
    try {
      const app = await buildApp();
      const res = await app.request("/api/tasks");
      expect(res.status).toBe(401);
    } finally {
      if (savedBypass !== undefined) {
        process.env.WEB_AUTH_BYPASS = savedBypass;
      }
    }
  });

  test("/api/tasks/stream returns 401 without auth", async () => {
    const savedBypass = process.env.WEB_AUTH_BYPASS;
    delete process.env.WEB_AUTH_BYPASS;
    try {
      const app = await buildApp();
      const res = await app.request("/api/tasks/stream");
      expect(res.status).toBe(401);
    } finally {
      if (savedBypass !== undefined) {
        process.env.WEB_AUTH_BYPASS = savedBypass;
      }
    }
  });
});
