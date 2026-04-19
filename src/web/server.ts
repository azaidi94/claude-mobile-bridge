import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createSessionsRouter } from "./routes/sessions";
import { createAgentsRouter } from "./routes/agents";
import { createSystemRouter } from "./routes/system";
import { createTasksRouter } from "./routes/tasks";
import { WEB_PORT, WEB_URL } from "../config";
import { info } from "../logger";
import { resolve, dirname } from "path";

const WEB_DIST = resolve(dirname(import.meta.dir), "..", "web", "dist");

export function startWebServer(): void {
  const port = WEB_PORT ?? 3000;

  const app = new Hono<{ Bindings: { remoteAddr: string | null } }>();

  app.route("/api/sessions", createSessionsRouter());
  app.route("/api/agents", createAgentsRouter());
  app.route("/api/system", createSystemRouter());
  app.route("/api/tasks", createTasksRouter());

  app.use("/*", serveStatic({ root: WEB_DIST }));

  app.get("*", async (c) => {
    const indexPath = `${WEB_DIST}/index.html`;
    const text = await Bun.file(indexPath)
      .text()
      .catch(() => "Mini App not built. Run: cd web && bun run build");
    return c.html(text);
  });

  const server = Bun.serve({
    port,
    idleTimeout: 0,
    fetch(request, s) {
      const ipInfo = s.requestIP(request);
      return app.fetch(request, { remoteAddr: ipInfo?.address ?? null });
    },
  });
  info(`web: server listening on port ${server.port}`);
}
