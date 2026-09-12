/**
 * /clear, /compact, /context, and the generic /claude passthrough — inject a
 * Claude Code slash command into the running desktop session's terminal TUI
 * (see terminal-inject.ts for the per-terminal-app mechanism). These are
 * *client* commands the relay can't trigger, so we type them in directly.
 */

import type { Context } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { isAuthorized } from "../../security";
import type { SessionContext } from "../../sessions/context";
import { busReply, resolveTopicSession } from "./helpers";
import { sendKeysToSession } from "./terminal-inject";
import { replyBlockedPanel } from "./tmux";
import { CLAUDE_COMMAND_REFERENCE } from "./claude-command-reference";

/**
 * Slash commands that must never be typed into the session via /claude:
 * exiting the CLI would kill the very process the bot is watching and orphan
 * the topic. Use the bot's own /kill or /stop for that instead.
 */
const CLAUDE_COMMAND_BLOCKLIST = new Set(["exit", "quit"]);

async function injectSlashCommand(
  ctx: Context,
  sctx: SessionContext | undefined,
  slash: string,
  doneLabel: string,
  pickerAction?: string,
): Promise<void> {
  if (!isAuthorized(ctx.from?.id, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  // Only offer the General-topic session picker for the fixed set of
  // commands callback.ts actually has a "<action>_pick:" dispatch entry
  // for (clear/compact/context). The generic /claude passthrough has no
  // such entry for arbitrary command names, so it skips straight to the
  // "use it in a session topic" message below instead of showing a picker
  // whose button would silently no-op (or collide with an unrelated
  // command that happens to share a name, e.g. /claude model).
  if (!sctx && pickerAction && (await resolveTopicSession(ctx, pickerAction)))
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
    return;
  }
  // The text never reached the input bar. Show the pane and the key panel so it
  // can be answered from here, rather than a dead-end error. The headline comes
  // from the guard, which knows whether a modal was actually detected.
  if (result.blocked && result.launchUuid && result.pane) {
    await replyBlockedPanel(
      ctx,
      result.launchUuid,
      result.pane,
      result.blockedHeadline,
    );
    return;
  }
  await busReply(ctx, `❌ Couldn't send ${slash}: ${result.reason}`);
}

/** /clear — clear the desktop session's conversation. */
export async function handleClear(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  await injectSlashCommand(
    ctx,
    sctx,
    "/clear",
    "🧹 Sent /clear.",
    "clear_pick",
  );
}

/** /compact — compact the desktop session's context. */
export async function handleCompact(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  await injectSlashCommand(
    ctx,
    sctx,
    "/compact",
    "🗜 Sent /compact.",
    "compact_pick",
  );
}

/** /context — show the desktop session's context-window usage. */
export async function handleContext(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  await injectSlashCommand(
    ctx,
    sctx,
    "/context",
    "📊 Sent /context.",
    "context_pick",
  );
}

/**
 * /claude — generic passthrough to Claude Code's own slash commands, plus a
 * built-in reference when called with no argument.
 *
 * `/claude <text>` types `/<text>` into the terminal exactly like
 * /clear|/compact|/context above, for every other CC slash command (/model,
 * /plan, /resume, ...) without needing a dedicated bot command per entry.
 * `/claude` alone lists the built-in commands instead of injecting nothing.
 */
export async function handleClaude(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  const arg = ((ctx.match as string | undefined) ?? "").trim();
  if (!arg) {
    await busReply(ctx, CLAUDE_COMMAND_REFERENCE, "html");
    return;
  }
  // Reject embedded newlines outright: a literal tmux send-keys payload
  // transmits them as raw LF bytes, which a line-oriented TUI reads as
  // Enter — submitting the first line early and leaving the rest (e.g. a
  // blocklisted "exit") in the input bar for this handler's own trailing
  // Enter to submit, smuggling it past the blocklist check below.
  if (/[\r\n]/.test(arg)) {
    await busReply(ctx, "❌ /claude commands must be a single line.");
    return;
  }
  // Strip ALL leading slashes before both the blocklist check and the
  // injected command so the two can't disagree (e.g. "//exit" used to
  // check "/exit" against the blocklist — a miss — while injecting the
  // slash-normalized "exit").
  const stripped = arg.replace(/^\/+/, "");
  const name = stripped.split(/\s+/)[0]!.toLowerCase();
  if (CLAUDE_COMMAND_BLOCKLIST.has(name)) {
    await busReply(
      ctx,
      `/claude ${name} is blocked — it would exit the CLI the bot is watching. Use /kill or /stop instead.`,
    );
    return;
  }
  const slash = `/${stripped}`;
  await injectSlashCommand(ctx, sctx, slash, `➡️ Sent ${slash}.`);
}
