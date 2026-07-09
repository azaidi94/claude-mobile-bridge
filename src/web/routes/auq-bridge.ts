import { Hono } from "hono";
import { timingSafeCompare } from "../auth";
import {
  register,
  waitFor,
  deleteEntry,
} from "../../handlers/auq-bridge-registry";
import { findWatchByDir, findWatchBySessionId } from "../../handlers/watch";
import {
  getTopicBySessionDir,
  topicForSessionId,
  getTopicStore,
} from "../../topics";
import { launchUuidForSessionId } from "../../sessions/resolve-session";

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
  return timingSafeCompare(h, `Bearer ${secret}`);
}

export function createAuqBridgeRouter(): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    if (!checkAuth(c)) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json<PostBody>();
    if (!body?.request_id || !body?.cwd || !body?.questions?.length) {
      return c.json({ error: "missing fields" }, 400);
    }
    // Route order (exact sessionId first so two sessions in ONE folder don't
    // cross-wire — routing by cwd alone sends the 2nd session's AUQ to the
    // 1st session's topic). The worker always posts session_id; cwd is the
    // legacy fallback for callers/sessions without a known id.
    //  1. Active /watch — by session_id, then by cwd.
    //  2. Topic store mapping — by session_id, then by sessionDir (group-forum
    //     mode: each session has its own topic, no /watch required). Without
    //     this, AUQs from sessions with a topic but no watch silently 404.
    // When session_id was posted but missed the id lookup, a match found purely
    // by cwd is only safe if it isn't a *different* session sharing the folder.
    // A candidate whose own sessionId is set and differs is a sibling cross-wire
    // (session B's AUQ landing in session A's topic) — reject it and fall
    // through (topic lookup, then 404) rather than misroute. A candidate with no
    // sessionId yet is the same session pre-id, so it's still accepted.
    const crossesSession = (candidateSessionId: string | undefined): boolean =>
      Boolean(
        body.session_id &&
        candidateSessionId &&
        candidateSessionId !== body.session_id,
      );

    let watch =
      (body.session_id ? findWatchBySessionId(body.session_id) : null) ?? null;
    if (!watch) {
      const byDir = findWatchByDir(body.cwd);
      if (byDir && !crossesSession(byDir.sessionId)) watch = byDir;
    }
    let chatId: number;
    let threadId: number;
    let sessionName: string;
    if (watch) {
      chatId = watch.chatId;
      threadId = watch.threadId;
      sessionName = watch.sessionName;
    } else {
      // topicForSessionId: exact live-id match first (sibling-safe), falling
      // back to the stable launchUuid only when the topic's sessionId has gone
      // stale (post-/clear) — recovers the AUQ route that a stale id would 404.
      let topic = body.session_id
        ? topicForSessionId({
            launchUuid: launchUuidForSessionId(body.session_id),
            sessionId: body.session_id,
          })
        : undefined;
      if (!topic) {
        const byDir = getTopicBySessionDir(body.cwd);
        if (byDir && !crossesSession(byDir.sessionId)) topic = byDir;
      }
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
