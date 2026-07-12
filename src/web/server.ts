import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createSessionsRouter } from "./routes/sessions";
import { createAgentsRouter } from "./routes/agents";
import { createSystemRouter } from "./routes/system";
import { createTasksRouter } from "./routes/tasks";
import { createAuqBridgeRouter } from "./routes/auq-bridge";
import { createWebhookRouter } from "./routes/webhook";
import { WEB_PORT, WEB_URL } from "../config";
import { info, warn } from "../logger";
import { resolve, dirname } from "path";

const WEB_DIST = resolve(dirname(import.meta.dir), "..", "web", "dist");

export function startWebServer(): void {
  const port = WEB_PORT ?? 3000;

  if (process.env.WEB_AUTH_BYPASS === "true") {
    const isLocal =
      WEB_URL.includes("localhost") ||
      WEB_URL.includes("127.0.0.1") ||
      WEB_URL.startsWith("http://0.0.0.0");
    if (!isLocal) {
      const line = "═".repeat(70);
      warn(
        `\n${line}\n` +
          "SECURITY WARNING: WEB_AUTH_BYPASS=true with non-local WEB_URL\n" +
          `  URL: ${WEB_URL}\n` +
          "  The Mini App API is publicly reachable WITHOUT authentication.\n" +
          "  Prefer WEB_AUTH_LAN_BYPASS=true (safe behind reverse proxy),\n" +
          "  or WEB_AUTH_BYPASS=false to enforce Telegram initData.\n" +
          `${line}`,
      );
    }
  }

  const app = new Hono<{ Bindings: { remoteAddr: string | null } }>();

  app.route("/api/sessions", createSessionsRouter());
  app.route("/api/agents", createAgentsRouter());
  app.route("/api/system", createSystemRouter());
  app.route("/api/tasks", createTasksRouter());
  app.route("/api/auq-bridge", createAuqBridgeRouter());
  app.route("/api/webhook", createWebhookRouter());

  // Cache-Control headers. Hashed assets in /assets/ are safe to cache forever
  // (the filename changes per build); index.html must always revalidate or the
  // Telegram mini-app webview will keep serving an old shell that references
  // a stale JS hash, and new deploys won't show up.
  app.use("/*", async (c, next) => {
    await next();
    const path = c.req.path;
    if (path.startsWith("/assets/")) {
      c.header("Cache-Control", "public, max-age=31536000, immutable");
    } else if (path === "/" || !path.includes(".") || path.endsWith(".html")) {
      c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    }
  });

  app.use("/*", serveStatic({ root: WEB_DIST }));

  app.get("*", async (c) => {
    // Hashed assets that don't exist must 404 — never fall back to index.html.
    // Otherwise a browser holding a stale index.html (referencing a renamed
    // bundle) silently receives HTML when it asks for JS, then tries to parse
    // <!doctype html>… as JavaScript and the page goes blank with no error
    // visible to a non-DevTools user.
    const path = c.req.path;
    if (
      path.startsWith("/assets/") ||
      /\.(js|css|map|json|woff2?|png|jpg|jpeg|svg|webp|ico)$/i.test(path)
    ) {
      return c.notFound();
    }
    const indexPath = `${WEB_DIST}/index.html`;
    const text = await Bun.file(indexPath)
      .text()
      .catch(() => "Mini App not built. Run: cd web && bun run build");
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    return c.html(text);
  });

  // Default to loopback so the API is not reachable from the network.
  // WEB_AUTH_LAN_BYPASS implies LAN exposure is intentional — bind 0.0.0.0
  // unless the operator pinned a specific address with WEB_BIND_HOST.
  const hostname =
    process.env.WEB_BIND_HOST ??
    (process.env.WEB_AUTH_LAN_BYPASS === "true" ? "0.0.0.0" : "127.0.0.1");

  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 0,
    fetch(request, s) {
      const ipInfo = s.requestIP(request);
      return app.fetch(request, { remoteAddr: ipInfo?.address ?? null });
    },
  });
  info("web: server listening", { hostname, port: server.port });
}
