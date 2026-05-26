import { Hono } from "hono";
import { authMiddleware } from "../auth";
import { readSnapshot } from "../tasks/reader";
import { subscribe } from "../tasks/watcher";

function getClaudeDir(): string {
  // Read dynamically so tests that set CLAUDE_DIR after config load still work.
  return process.env.CLAUDE_DIR || `${process.env.HOME}/.claude`;
}

export function createTasksRouter(): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/", async (c) => {
    const snapshot = await readSnapshot(getClaudeDir());
    return c.json(snapshot);
  });

  app.get("/stream", (c) => {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array>;

    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        controller = ctrl;
        ctrl.enqueue(encoder.encode(": connected\n\n"));
      },
    });

    const unsub = subscribe(getClaudeDir(), (evt) => {
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
      } catch {
        // silently ok: SSE client disconnected mid-stream
      }
    });

    const ping = setInterval(() => {
      try {
        controller.enqueue(encoder.encode(": ping\n\n"));
      } catch {
        clearInterval(ping);
      }
    }, 15000);

    c.req.raw.signal.addEventListener("abort", () => {
      unsub();
      clearInterval(ping);
      try {
        controller.close();
      } catch {
        // silently ok: controller may already be closed
      }
    });

    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  return app;
}
