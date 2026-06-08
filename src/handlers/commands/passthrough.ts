/**
 * Terminal passthrough commands — forward the user-typed slash command into
 * the target Claude Code session via the relay, so Claude interprets it as
 * its own slash command (e.g. /clear, /compact). Used for commands the bot
 * has no native handling for but the CLI does.
 */

import type { Context } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { isAuthorized } from "../../security";
import type { SessionContext } from "../../sessions/context";
import { busReply, resolveTopicSession } from "./helpers";

async function passthrough(
  ctx: Context,
  sctx: SessionContext | undefined,
  slashCommand: string,
): Promise<void> {
  if (!isAuthorized(ctx.from?.id, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  if (
    !sctx &&
    (await resolveTopicSession(ctx, `${slashCommand.slice(1)}_pick`))
  )
    return;

  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const username = ctx.from?.username || "telegram";
  const threadId = ctx.message?.message_thread_id;
  // Dynamic import keeps relay-bridge (and its TCP/JSONL transitive deps) out
  // of commands.ts's static module graph — tests mock `../relay` minimally.
  const { sendViaRelay } = await import("../relay-bridge");
  const result = await sendViaRelay(
    ctx,
    slashCommand,
    username,
    chatId,
    undefined,
    undefined,
    threadId,
    sctx,
  );

  if (result === "delivered") {
    await busReply(ctx, `▶ ${slashCommand} sent to terminal.`);
  } else if (result === "unavailable") {
    await busReply(
      ctx,
      `❌ Session offline — can't forward ${slashCommand}. Is the Claude relay running?`,
    );
  } else {
    await busReply(ctx, `❌ Failed to send ${slashCommand} to terminal.`);
  }
}

/** /clear — inject /clear into the target session. */
export async function handleClear(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  await passthrough(ctx, sctx, "/clear");
}

/** /compact — inject /compact into the target session. */
export async function handleCompact(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  await passthrough(ctx, sctx, "/compact");
}

/** /cost — inject /cost into the target session. */
export async function handleCost(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  await passthrough(ctx, sctx, "/cost");
}

/** /mcp — inject /mcp into the target session. */
export async function handleMcp(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  await passthrough(ctx, sctx, "/mcp");
}

/** /init — inject /init into the target session. */
export async function handleInit(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  await passthrough(ctx, sctx, "/init");
}

/** /login — inject /login into the target session. */
export async function handleLogin(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  await passthrough(ctx, sctx, "/login");
}
