/**
 * /run <prompt> — async mode. Fires the prompt at the topic's session,
 * doesn't await the reply, and pings ✅ /run done when the turn ends.
 */

import type { Context } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { isAuthorized } from "../../security";
import {
  clearPendingRunCompletion,
  isWatching,
  markPendingRunCompletion,
  sendWatchRelay,
} from "../watch";
import { createOpId, info, warn } from "../../logger";
import { busReply } from "./helpers";

/**
 * /run <prompt> — async mode. Forwards the prompt to the topic's session
 * without awaiting the reply, then pings "✅ /run done" when the turn ends.
 *
 * Requires a session topic with an active watch (auto-watch covers this in
 * group mode). Stuck runs are caught by the watchdog (see WATCHDOG_IDLE_MS).
 */
export async function handleRun(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }
  if (!chatId) return;

  // Strip the /run command itself, leaving the prompt body.
  const text = (ctx.message?.text ?? "").replace(/^\/run(?:@\S+)?\s*/, "");
  const prompt = text.trim();
  if (!prompt) {
    await busReply(
      ctx,
      "Usage: <code>/run &lt;prompt&gt;</code>\n\nFires the prompt without waiting for the reply, then pings <b>✅ /run done</b> when the turn ends.",
      "html",
    );
    return;
  }

  if (threadId === undefined) {
    await busReply(
      ctx,
      "/run only works inside a session topic — use it where the watch is active.",
    );
    return;
  }
  if (!isWatching(chatId, threadId)) {
    await busReply(
      ctx,
      "/run needs an active watch on this topic. Send a message first to auto-watch, or use /watch.",
    );
    return;
  }

  const username = ctx.from?.username || "unknown";
  const opId = createOpId("run");

  // Reject second /run before sending relay — overwriting the pending
  // completion would silently drop the first run's ping.
  const armed = markPendingRunCompletion(chatId, threadId, prompt);
  if (armed === "already-pending") {
    await busReply(
      ctx,
      "⏳ another /run is still pending in this topic — wait for its ✅ before queuing another.",
    );
    return;
  }
  if (armed === "no-watch") {
    // Race: watch was torn down between the isWatching check and now.
    warn("run: arm failed, watch torn down between check and arm", {
      opId,
      chatId,
      threadId,
    });
    await busReply(ctx, "⚠ couldn't arm completion ping (watch lost).");
    return;
  }

  const queued = await sendWatchRelay(chatId, threadId, username, prompt, opId);
  if (!queued) {
    // Roll back the armed state so a retry isn't blocked by "already-pending".
    clearPendingRunCompletion(chatId, threadId);
    await busReply(ctx, "❌ relay unavailable — couldn't queue.");
    return;
  }

  await busReply(ctx, "▶ queued — will ping when done.");
  info("run: queued", {
    opId,
    chatId,
    threadId,
    promptPreview: prompt.slice(0, 120),
  });
}
