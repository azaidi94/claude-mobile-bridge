import { Hono } from "hono";
import {
  register,
  waitFor,
  deleteEntry,
} from "../../handlers/auq-bridge-registry";
import { findWatchByDir } from "../../handlers/watch";
import { getTopicBySessionDir, getTopicStore } from "../../topics";

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
    // Route order:
    //  1. Active /watch for the cwd (legacy single-topic / explicit subscribe)
    //  2. Topic store mapping by sessionDir (group-forum mode: each session
    //     has its own topic, so the topic is the routing key — no /watch
    //     required). Without this fallback, AUQs from sessions that have a
    //     topic but no active watch silently 404 and never reach Telegram.
    const watch = findWatchByDir(body.cwd);
    let chatId: number;
    let threadId: number;
    let sessionName: string;
    if (watch) {
      chatId = watch.chatId;
      threadId = watch.threadId;
      sessionName = watch.sessionName;
    } else {
      const topic = getTopicBySessionDir(body.cwd);
      const store = getTopicStore();
      if (!topic || !store.chatId) {
        return c.json({ error: "no watch or topic for cwd" }, 404);
      }
      chatId = store.chatId;
      threadId = topic.topicId;
      sessionName = topic.sessionName;
    }

    register({
      requestId: body.request_id,
      toolUseId: body.tool_use_id,
      sessionName,
      chatId,
      threadId,
      questions: body.questions,
      tmuxPane: body.tmux_pane,
    });
    const { startBridgeFromRoute } = await import("../../handlers/auq-bridge");
    startBridgeFromRoute(body.request_id).catch(() => {});

    return c.json({ request_id: body.request_id, chatId, threadId });
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
