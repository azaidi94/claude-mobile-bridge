/**
 * POST /api/webhook/notify — external "wake" injector.
 *
 * Lets CI, cron jobs, deploy scripts, and other off-box systems push a
 * status message into a Telegram topic without going through the bot's
 * watch path. Authentication is a shared bearer secret (env WEBHOOK_SECRET);
 * empty secret disables the route entirely so a misconfigured deployment
 * can't expose the bot's TG presence.
 *
 * Request body (JSON):
 *   { session?: string, topicId?: number, text: string, source?: string }
 *
 * - session: routes via topic-store.topicForSession (launchUuid-first, name fallback)
 * - topicId: direct thread_id (skips session lookup; useful for General topic)
 * - text: message body (markdown → HTML via bus auto-format)
 * - source: optional label prepended as "🪝 <source>:" header
 */

import { Hono } from "hono";
import { WEBHOOK_SECRET } from "../../config";
import { timingSafeCompare } from "../auth";
import { getTopicStore, topicForSession } from "../../topics/topic-store";
import { getSession } from "../../sessions";
import { launchUuidForPid } from "../../sessions/resolve-session";
import { getMessageBus } from "../../messaging";
import { escapeHtml } from "../../formatting";
import { info, error as logError } from "../../logger";

interface WebhookBody {
  session?: string;
  topicId?: number;
  text?: string;
  source?: string;
}

export function createWebhookRouter(): Hono {
  const app = new Hono();

  app.post("/notify", async (c) => {
    if (!WEBHOOK_SECRET) {
      return c.json({ ok: false, error: "webhook disabled" }, 503);
    }

    const auth = c.req.header("Authorization") ?? "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!timingSafeCompare(provided, WEBHOOK_SECRET)) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }

    let body: WebhookBody;
    try {
      body = (await c.req.json()) as WebhookBody;
    } catch {
      return c.json({ ok: false, error: "invalid json" }, 400);
    }

    const text = (body.text ?? "").trim();
    if (!text) {
      return c.json({ ok: false, error: "text required" }, 400);
    }

    const store = getTopicStore();
    const chatId = store.chatId;
    if (!chatId) {
      return c.json({ ok: false, error: "no chat registered" }, 503);
    }

    let threadId: number | undefined;
    if (typeof body.topicId === "number") {
      threadId = body.topicId;
    } else if (body.session) {
      const mapping = topicForSession({
        launchUuid: launchUuidForPid(getSession(body.session)?.pid),
        sessionName: body.session,
      });
      if (!mapping) {
        return c.json(
          { ok: false, error: `unknown session: ${body.session}` },
          404,
        );
      }
      threadId = mapping.topicId;
    }

    const source = (body.source ?? "").trim();
    const header = source ? `🪝 <b>${escapeHtml(source)}:</b>\n` : "";
    // When source is set the message is sent as HTML; escape user text to avoid
    // Telegram rejecting or misinterpreting stray <, >, & characters.
    const content = header + (source ? escapeHtml(text) : text);

    try {
      await getMessageBus().send({
        chatId,
        threadId,
        content,
        format: source ? "html" : "auto",
        silent: false,
      });
      info("webhook: delivered", {
        source: source || "(none)",
        session: body.session ?? "(direct topic)",
        threadId,
        bytes: text.length,
      });
      return c.json({ ok: true });
    } catch (err) {
      logError("webhook: send failed", err, {
        session: body.session,
        topic: threadId,
      });
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  return app;
}
