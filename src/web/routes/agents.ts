import { Hono } from "hono";
import { authMiddleware } from "../auth";
import { addTelegramSession } from "../../sessions";
import { existsSync } from "fs";

export function createAgentsRouter(): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.post("/spawn", async (c) => {
    const body = await c.req.json<{ dir: string }>();
    if (!body.dir?.trim()) return c.json({ error: "dir required" }, 400);
    if (!existsSync(body.dir)) return c.json({ error: "dir not found" }, 404);

    const sess = addTelegramSession(body.dir);
    return c.json({ ok: true, sessionId: sess.id, name: sess.name });
  });

  return app;
}
