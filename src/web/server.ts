import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createSessionsRouter } from "./routes/sessions";
import { createAgentsRouter } from "./routes/agents";
import { createSystemRouter } from "./routes/system";
import { WEB_PORT } from "../config";
import { info } from "../logger";
import { resolve, dirname } from "path";

const WEB_DIST = resolve(dirname(import.meta.dir), "..", "web", "dist");

export function startWebServer(): void {
  const port = WEB_PORT ?? 3000;

  const app = new Hono();

  app.route("/api/sessions", createSessionsRouter());
  app.route("/api/agents", createAgentsRouter());
  app.route("/api/system", createSystemRouter());

  app.use("/*", serveStatic({ root: WEB_DIST }));

  app.get("*", async (c) => {
    const indexPath = `${WEB_DIST}/index.html`;
    const text = await Bun.file(indexPath)
      .text()
      .catch(() => "Mini App not built. Run: cd web && bun run build");
    return c.html(text);
  });

  Bun.serve({ port, fetch: app.fetch, idleTimeout: 0 });
  info(`web: server listening on port ${port}`);
}
