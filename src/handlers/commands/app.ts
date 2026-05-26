/**
 * /app — reply with a link to open the Mini App.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { ALLOWED_USERS, WEB_URL, WEB_APP_SHORT_URL } from "../../config";
import { isAuthorized, rateLimiter } from "../../security";
import { busReply } from "./helpers";

/**
 * /app — reply with a link to open the Mini App.
 * Private chat: inline keyboard with a web_app button.
 * Group/topic: plain URL (web_app buttons aren't allowed in groups).
 * If WEB_APP_SHORT_URL is set, prefer the t.me deep link everywhere — it opens
 * the registered Mini App without needing the direct HTTPS URL.
 */
export async function handleApp(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  const [allowed, retryAfter] = rateLimiter.check(userId!);
  if (!allowed) {
    await busReply(ctx, `⏳ Rate limited. Wait ${retryAfter!.toFixed(1)}s.`);
    return;
  }

  const shortUrl = WEB_APP_SHORT_URL;
  const url = WEB_URL;
  const threadId = ctx.message?.message_thread_id;

  // TODO(phase-2 link_preview): bus doesn't yet carry link_preview_options.
  // Keep these two sites inline until the bus grows that option.
  if (shortUrl) {
    await ctx.reply(`Open the Mini App:\n${shortUrl}`, {
      message_thread_id: threadId,
      link_preview_options: { is_disabled: true },
    });
    return;
  }

  if (ctx.chat?.type === "private") {
    await busReply(ctx, "Open the Mini App:", {
      replyMarkup: new InlineKeyboard().webApp("Open", url),
    });
    return;
  }

  await ctx.reply(
    `Mini App: ${url}\n(Open inside a private chat with the bot for the tap-to-launch button.)`,
    {
      message_thread_id: threadId,
      link_preview_options: { is_disabled: true },
    },
  );
}
