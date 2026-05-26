/**
 * /switch <name> — switch to a session (v1 non-topic flow).
 */

import type { Context } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { isAuthorized } from "../../security";
import {
  setActiveSession,
  getSession,
  sendSwitchHistory,
} from "../../sessions";
import { getSessionState } from "../../sessions/session-state";
import { busReply, isTopicChat } from "./helpers";

/**
 * /switch <name> - Switch to a session.
 */
export async function handleSwitch(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  if (isTopicChat(ctx)) {
    await busReply(
      ctx,
      "ℹ️ /switch is not needed with topics. Just open a session topic.",
    );
    return;
  }

  const text = ctx.message?.text || "";
  const name = text.split(/\s+/)[1];

  if (!name) {
    await busReply(ctx, "Usage: /switch &lt;name&gt;", "html");
    return;
  }

  const success = setActiveSession(name);

  if (success) {
    const info = getSession(name);
    if (info) {
      getSessionState(info.name).loadFromRegistry(info);
      const dir = info.dir.replace(/^\/Users\/[^/]+/, "~");

      await sendSwitchHistory(ctx, info);
      await busReply(
        ctx,
        `✅ <code>${name}</code>\n📁 <code>${dir}</code>`,
        "html",
      );
    }
  } else {
    await busReply(ctx, `❌ "${name}" not found. Use /list.`);
  }
}
