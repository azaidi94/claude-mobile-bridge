import { Hono } from "hono";
import {
  getSessions,
  getActiveSession,
  setActiveSession,
} from "../../sessions";
import { listOfflineSessions } from "../../sessions/offline";
import { globalEventBus } from "../sse";
import type { SseEvent } from "../sse";
import { authMiddleware } from "../auth";
import type { SessionInfo } from "../../sessions/types";
import { session as claudeSession } from "../../session";
import { getRelayClient } from "../../relay";
import type { RelayReply } from "../../relay";

export interface ApiSession {
  id: string;
  name: string;
  dir: string;
  lastActivity: number;
  source: "telegram" | "desktop";
  live: boolean;
  active: boolean;
}

export function serializeSessions(
  sessions: Map<string, SessionInfo>,
): ApiSession[] {
  const active = getActiveSession();
  return [...sessions.values()]
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .map((s) => ({
      id: s.id,
      name: s.name,
      dir: s.dir,
      lastActivity: s.lastActivity,
      source: s.source,
      live: true,
      active: active?.name === s.name,
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
    const active = getActiveSession();
    const liveDirs = new Set(sessions.map((s) => s.dir));
    const live: ApiSession[] = sessions.map((s) => ({
      id: s.id,
      name: s.name,
      dir: s.dir,
      lastActivity: s.lastActivity,
      source: s.source,
      live: true,
      active: active?.name === s.name,
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
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array>;

    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        controller = ctrl;
        ctrl.enqueue(encoder.encode(": connected\n\n"));
      },
    });

    const unsub = globalEventBus.subscribe(sessionId, (evt) => {
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

  app.post("/:id/message", async (c) => {
    const sessionId = c.req.param("id");
    const body = await c.req.json<{ text: string }>();
    if (!body.text?.trim()) return c.json({ error: "text required" }, 400);

    const sessions = getSessions();
    const found = sessions.find((s) => s.id === sessionId);

    const emit = (type: SseEvent["type"], content: string) =>
      globalEventBus.emit(sessionId, { type, content });

    if (found?.source === "desktop") {
      sendWebRelay(found, body.text, emit);
    } else {
      if (found) claudeSession.loadFromRegistry(found);
      const cb = globalEventBus.makeStatusCallback(sessionId);
      claudeSession
        .sendMessageStreaming(body.text, "web", 0, cb)
        .catch(() => emit("done", ""));
    }

    return c.json({ ok: true });
  });

  app.post("/:name/activate", (c) => {
    const name = c.req.param("name");
    const sessions = getSessions();
    const found = sessions.find((s) => s.name === name);
    if (!found) return c.json({ error: "session not found" }, 404);
    setActiveSession(name);
    claudeSession.loadFromRegistry(found);
    return c.json({ ok: true });
  });

  return app;
}
