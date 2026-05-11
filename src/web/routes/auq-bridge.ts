import { Hono } from "hono";
import {
  register,
  waitFor,
  deleteEntry,
} from "../../handlers/auq-bridge-registry";
import { findWatchByDir } from "../../handlers/watch";

interface PostBody {
  request_id: string;
  tool_use_id: string;
  session_id: string;
  cwd: string;
  questions: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
  tmux_pane?: string;
}

function checkAuth(c: {
  req: { header: (k: string) => string | undefined };
}): boolean {
  // Read at request time so tests can set process.env.RELAY_AUQ_SECRET before
  // the first request without being foiled by module-load-time constant capture.
  const secret = process.env.RELAY_AUQ_SECRET?.trim() || "";
  if (!secret) return false;
  const h = c.req.header("Authorization") ?? "";
  return h === `Bearer ${secret}`;
}

export function createAuqBridgeRouter(): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    if (!checkAuth(c)) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json<PostBody>();
    if (!body?.request_id || !body?.cwd || !body?.questions?.length) {
      return c.json({ error: "missing fields" }, 400);
    }
    const watch = findWatchByDir(body.cwd);
    if (!watch) return c.json({ error: "no active watch for cwd" }, 404);

    register({
      requestId: body.request_id,
      toolUseId: body.tool_use_id,
      sessionName: watch.sessionName,
      chatId: watch.chatId,
      threadId: watch.threadId,
      questions: body.questions,
      tmuxPane: body.tmux_pane,
    });
    const { startBridgeFromRoute } = await import("../../handlers/auq-bridge");
    startBridgeFromRoute(body.request_id).catch(() => {});

    return c.json({
      request_id: body.request_id,
      chatId: watch.chatId,
      threadId: watch.threadId,
    });
  });

  app.get("/:id/answer", async (c) => {
    if (!checkAuth(c)) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    const waitMs = Math.min(
      parseInt(c.req.query("wait_ms") ?? "30000", 10) || 30000,
      60_000,
    );
    // If the long-poll client disconnects before we resolve, drop the registry
    // entry so it doesn't leak (worker can re-POST a fresh bridge if needed).
    c.req.raw.signal.addEventListener("abort", () => deleteEntry(id));
    const result = await waitFor(id, waitMs);
    if (result.status === "timeout") return c.json({ status: "timeout" }, 408);
    deleteEntry(id);
    return c.json(result);
  });

  return app;
}
