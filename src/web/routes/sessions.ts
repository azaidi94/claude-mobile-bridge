import { Hono } from "hono";
import { getSessions, setActiveSession, getSessionState } from "../../sessions";
import { listOfflineSessions } from "../../sessions/offline";
import { globalEventBus } from "../sse";
import type { SseEvent } from "../sse";
import { authMiddleware } from "../auth";
import type { SessionInfo } from "../../sessions/types";
import { runQueryStreaming, getCurrentModel } from "../../session";
import { getRelayClient } from "../../relay";
import type { RelayReply } from "../../relay";
import { readSessionHistory } from "../sessions/history";
import { findNewestSessionInDir } from "../../sessions/tailer";
import { warn } from "../../logger";
import {
  submitAnswerFromWeb,
  cancelAnswerFromWeb,
} from "../../handlers/relay-ask";
import { getOpenAsksForSession } from "../../handlers/auq-bridge";

export interface ApiSession {
  id: string;
  name: string;
  dir: string;
  lastActivity: number;
  source: "telegram" | "desktop" | "cursor";
  live: boolean;
  active: boolean;
}

export function serializeSessions(
  sessions: Map<string, SessionInfo>,
): ApiSession[] {
  // `active` is no longer surfaced — the global active pointer was retired
  // in task 7g. Web clients should rely on per-session interaction state.
  return [...sessions.values()]
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .map((s) => ({
      id: s.id,
      name: s.name,
      dir: s.dir,
      lastActivity: s.lastActivity,
      source: s.source,
      live: true,
      active: false,
    }));
}

async function sendWebRelay(
  session: SessionInfo,
  text: string,
  emit: (type: SseEvent["type"], content: string) => void,
): Promise<void> {
  const client = await getRelayClient({
    sessionId: session.id,
    sessionDir: session.dir,
    claudePid: session.pid,
  });
  if (!client) {
    emit("text", "⚠ Relay unavailable for this session.");
    emit("done", "");
    return;
  }

  const chatId = "web";
  emit("thinking", "...");

  client.sendMessage({ chat_id: chatId, user: "web", text });

  await new Promise<void>((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      client.offReply(onReply);
      client.offDisconnect(onDisconnect);
    };

    const onReply = (msg: RelayReply) => {
      cleanup();
      emit("text", msg.text);
      emit("done", "");
      resolve();
    };

    const onDisconnect = () => {
      cleanup();
      emit("done", "");
      resolve();
    };

    const timer = setTimeout(() => {
      cleanup();
      emit("text", "⚠ Relay response timed out.");
      emit("done", "");
      resolve();
    }, 120_000);

    client.onReply(onReply, chatId);
    client.onDisconnect(onDisconnect);
  });
}

export function createSessionsRouter(): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/", async (c) => {
    const sessions = getSessions();
    const liveDirs = new Set(sessions.map((s) => s.dir));
    const live: ApiSession[] = sessions.map((s) => ({
      id: s.id,
      name: s.name,
      dir: s.dir,
      lastActivity: s.lastActivity,
      source: s.source,
      live: true,
      active: false,
    }));
    const offline = await listOfflineSessions();
    const offlineApi: ApiSession[] = offline
      .filter((o) => !liveDirs.has(o.dir))
      .map((o) => ({
        id: o.encodedDir,
        name: o.dir.split("/").pop() ?? o.encodedDir,
        dir: o.dir,
        lastActivity: o.lastActivity,
        source: "desktop" as const,
        live: false,
        active: false,
      }));
    return c.json([...live, ...offlineApi]);
  });

  app.get("/:id/stream", (c) => {
    const sessionId = c.req.param("id");
    // Resolve the session name (stable across UUID drifts) to use as the SSE
    // bus key, matching how the tailer emits events. If `getSessions()` hasn't
    // observed this session yet (boot race), the fallback to `sessionId` will
    // miss any tailer events keyed by name — log so the dropped-events case
    // is observable rather than silent.
    const sessions = getSessions();
    const known = sessions.find((s) => s.id === sessionId);
    if (!known) {
      warn("web/sse: session not in registry, using sessionId as bus key", {
        sessionId,
      });
    }
    const sessionName = known?.name ?? sessionId;
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array>;

    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        controller = ctrl;
        ctrl.enqueue(encoder.encode(": connected\n\n"));
        // Authoritative snapshot of currently-open bridge asks. EventSource
        // auto-reconnects don't replay missed events, so a client that
        // disconnected between an `ask_remote` and its `ask_remote_cleared`
        // would otherwise carry the stale card forever. The snapshot is the
        // single source of truth — the client reconciles by replacing any
        // open asks not present here as cleared.
        const askOpen = getOpenAsksForSession(sessionName);
        ctrl.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "ask_remote_state",
              content: "",
              askOpen,
            } satisfies SseEvent)}\n\n`,
          ),
        );
      },
    });

    const unsub = globalEventBus.subscribe(sessionName, (evt) => {
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
      } catch {}
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
      } catch {}
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

  app.get("/:id/history", async (c) => {
    const sessionId = c.req.param("id");
    const limit = parseInt(c.req.query("limit") ?? "200", 10);
    const safeLimit =
      Number.isFinite(limit) && limit > 0 ? Math.min(limit, 2000) : 200;

    // Fall back to the most-recently-modified JSONL only when this dir hosts
    // a single live session — otherwise newest-in-dir could silently serve a
    // sibling's history. The fallback handles Claude Code restarts that
    // assign a new UUID to the same project (tailer uses the same logic).
    const sessions = getSessions();
    const session = sessions.find((s) => s.id === sessionId);
    const hasSibling =
      session?.dir &&
      sessions.some((s) => s.dir === session.dir && s.id !== session.id);
    const resolvedId =
      session?.dir && !hasSibling
        ? ((await findNewestSessionInDir(session.dir)) ?? sessionId)
        : sessionId;

    const events = await readSessionHistory(resolvedId, safeLimit);
    return c.json({ events });
  });

  app.post("/:id/message", async (c) => {
    const sessionId = c.req.param("id");
    const body = await c.req.json<{ text: string; clientId?: string }>();
    if (!body.text?.trim()) return c.json({ error: "text required" }, 400);

    const sessions = getSessions();
    const found = sessions.find((s) => s.id === sessionId);
    const busKey = found?.name ?? sessionId;

    const emit = (type: SseEvent["type"], content: string) =>
      globalEventBus.emit(busKey, { type, content });

    globalEventBus.emit(busKey, {
      type: "user_message",
      source: "web",
      content: body.text,
      clientId: body.clientId,
    });

    if (found?.source === "cursor") {
      // CursorBridge subscribes to the bus and injects into Composer.
      // No SDK call — cursor sessions aren't backed by a Claude SDK process.
      return c.json({ ok: true });
    }

    if (found?.source === "desktop") {
      sendWebRelay(found, body.text, emit);
    } else {
      const state = getSessionState(busKey);
      if (found) state.loadFromRegistry(found);
      const cb = globalEventBus.makeStatusCallback(busKey);
      runQueryStreaming(state, {
        message: body.text,
        username: "web",
        userId: 0,
        statusCallback: cb,
        model: getCurrentModel(),
      }).catch(() => emit("done", ""));
    }

    return c.json({ ok: true });
  });

  app.post("/:name/activate", (c) => {
    const name = c.req.param("name");
    const sessions = getSessions();
    const found = sessions.find((s) => s.name === name);
    if (!found) return c.json({ error: "session not found" }, 404);
    setActiveSession(name);
    getSessionState(found.name).loadFromRegistry(found);
    return c.json({ ok: true });
  });

  // Web-side answer for an in-flight ask_remote tool call. Routes through
  // the same MCP path TG button taps use; a 404 means the question already
  // resolved (TG, timeout, disconnect) before this request arrived.
  app.post("/ask-remote-answer", async (c) => {
    const body = await c.req.json<{
      ask_id?: string;
      answer?: string;
      cancel?: boolean;
    }>();
    const askId = String(body.ask_id ?? "");
    if (!askId) return c.json({ error: "ask_id required" }, 400);

    // AUQ-bridge route — handled before the MCP ask_remote path so bridge:*
    // askIds never reach submitAnswerFromWeb (which is for MCP-only).
    if (askId.startsWith("bridge:")) {
      const { parseBridgeAskId, _injectWebAnswer } =
        await import("../../handlers/auq-bridge");
      const parsed = parseBridgeAskId(askId);
      if (!parsed) return c.json({ error: "invalid bridge askId" }, 400);
      if (body.cancel) {
        // M1: cancellation from Web UI isn't supported for the bridge (the TG
        // side has no way to cancel either; cancellation only flows from the
        // local TUI via bus tool_result observation).
        return c.json({ error: "cancel not supported for bridge" }, 400);
      }
      const answer = String(body.answer ?? "");
      if (!answer.trim()) return c.json({ error: "answer required" }, 400);
      const ok = _injectWebAnswer(
        parsed.requestId,
        parsed.questionIndex,
        answer,
      );
      return ok
        ? c.json({ ok: true })
        : c.json({ error: "bridge not pending" }, 404);
    }

    // Existing MCP ask_remote path (unchanged)
    if (body.cancel) {
      const ok = cancelAnswerFromWeb(askId);
      return ok
        ? c.json({ ok: true })
        : c.json({ error: "ask not pending" }, 404);
    }
    const answer = String(body.answer ?? "");
    if (!answer.trim()) {
      return c.json({ error: "answer required (or pass cancel:true)" }, 400);
    }
    const ok = submitAnswerFromWeb(askId, answer);
    return ok
      ? c.json({ ok: true })
      : c.json({ error: "ask not pending" }, 404);
  });

  return app;
}
