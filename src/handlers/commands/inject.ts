/**
 * /clear and /compact — inject the matching Claude Code slash command into the
 * running desktop session's terminal TUI (see terminal-inject.ts for the
 * per-terminal-app mechanism). These are *client* commands the relay can't
 * trigger, so we type them in directly.
 */

import type { Context } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { isAuthorized } from "../../security";
import type { SessionContext } from "../../sessions/context";
import { busReply, resolveTopicSession } from "./helpers";
import { sendKeysToSession } from "./terminal-inject";

async function injectSlashCommand(
  ctx: Context,
  sctx: SessionContext | undefined,
  slash: string,
  doneLabel: string,
): Promise<void> {
  if (!isAuthorized(ctx.from?.id, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  if (!sctx && (await resolveTopicSession(ctx, `${slash.slice(1)}_pick`)))
    return;

  if (!sctx) {
    await busReply(ctx, `Use ${slash} in a Claude session topic.`);
    return;
  }
  if (sctx.source !== "cc") {
    // We're in a session topic, just not an injectable one — say why rather
    // than the misleading "use it in a session topic".
    await busReply(
      ctx,
      `${slash} isn't supported for ${sctx.source} sessions yet.`,
    );
    return;
  }

  const result = await sendKeysToSession(sctx, slash);
  if (result.ok) {
    await busReply(
      ctx,
      result.note ? `${doneLabel} (${result.note})` : doneLabel,
    );
  } else {
    await busReply(ctx, `❌ Couldn't send ${slash}: ${result.reason}`);
  }
}

/** /clear — clear the desktop session's conversation. */
export async function handleClear(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  await injectSlashCommand(ctx, sctx, "/clear", "🧹 Sent /clear.");
}

/** /compact — compact the desktop session's context. */
export async function handleCompact(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  await injectSlashCommand(ctx, sctx, "/compact", "🗜 Sent /compact.");
}
