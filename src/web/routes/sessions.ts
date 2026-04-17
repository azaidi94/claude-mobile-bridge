import { Hono } from "hono";
import { stream } from "hono/streaming";
import {
  getSessions,
  getActiveSession,
  setActiveSession,
} from "../../sessions";
import { listOfflineSessions } from "../../sessions/offline";
import { globalEventBus } from "../sse";
import { authMiddleware } from "../auth";
import type { SessionInfo } from "../../sessions/types";
import { session as claudeSession } from "../../session";

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
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    return stream(c, async (s) => {
      const unsub = globalEventBus.subscribe(sessionId, async (evt) => {
        await s.write(`data: ${JSON.stringify(evt)}\n\n`);
      });
      const ping = setInterval(async () => {
        await s.write(": ping\n\n");
      }, 15000);
      await new Promise<void>((resolve) => {
        s.onAbort(() => {
          unsub();
          clearInterval(ping);
          resolve();
        });
      });
    });
  });

  app.post("/:id/message", async (c) => {
    const sessionId = c.req.param("id");
    const body = await c.req.json<{ text: string }>();
    if (!body.text?.trim()) return c.json({ error: "text required" }, 400);

    const cb = globalEventBus.makeStatusCallback(sessionId);
    claudeSession.sendMessageStreaming(body.text, "web", 0, cb).catch(() => {});
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
