/**
 * /prompts — saved prompt menu rendered as a tappable inline keyboard.
 *
 *   /prompts                              → menu of visible prompts
 *   /prompts add <label> | <prompt text>  → save (global)
 *   /prompts add! <label> | <text>        → save scoped to THIS topic's session
 *   /prompts del <id>                     → remove
 *
 * Tapping a button injects the prompt's full text into the session as if
 * the user had typed it (handled by handleCallback's "prompt:" branch).
 */

import type { Context } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { isAuthorized } from "../../security";
import { getPrompts, addPrompt, removePrompt } from "../../prompts/store";
import { escapeHtml } from "../../formatting";
import type { SessionContext } from "../../sessions/context";
import { busReply } from "./helpers";

const USAGE = [
  "<b>Usage:</b>",
  "<code>/prompts</code> — show menu",
  "<code>/prompts add &lt;label&gt; | &lt;text&gt;</code>",
  "<code>/prompts add! &lt;label&gt; | &lt;text&gt;</code> — scope to this session",
  "<code>/prompts del &lt;id&gt;</code>",
].join("\n");

export async function handlePrompts(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  if (!isAuthorized(ctx.from?.id, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  const raw = ctx.message?.text ?? "";
  const args = raw.replace(/^\/prompts(@\S+)?\s*/, "").trim();

  if (!args) {
    await showMenu(ctx, sctx);
    return;
  }
  if (args.startsWith("add!")) {
    await addCmd(ctx, sctx, args.slice(4).trim(), true);
    return;
  }
  if (args.startsWith("add ")) {
    await addCmd(ctx, sctx, args.slice(4).trim(), false);
    return;
  }
  if (args.startsWith("del ") || args.startsWith("rm ")) {
    const id = args.split(/\s+/)[1] ?? "";
    await delCmd(ctx, id);
    return;
  }

  await busReply(ctx, USAGE, "html");
}

async function showMenu(ctx: Context, sctx?: SessionContext): Promise<void> {
  const scope = sctx?.sessionName;
  const prompts = await getPrompts(scope);
  if (!prompts.length) {
    await busReply(
      ctx,
      `No saved prompts${scope ? ` for <b>${escapeHtml(scope)}</b>` : ""}.\n\n${USAGE}`,
      "html",
    );
    return;
  }

  // Buttons one per row — labels can be wide and stacking keeps them readable
  // on narrow phone screens.
  const inline_keyboard = prompts.map((p) => [
    {
      text: p.label.slice(0, 64) + (p.sessionScope ? " 📌" : ""),
      callback_data: `prompt:${p.id}`,
    },
  ]);

  await busReply(
    ctx,
    `<b>Saved prompts</b>${scope ? ` — ${escapeHtml(scope)}` : ""}`,
    {
      format: "html",
      replyMarkup: { inline_keyboard },
    },
  );
}

async function addCmd(
  ctx: Context,
  sctx: SessionContext | undefined,
  rest: string,
  scoped: boolean,
): Promise<void> {
  const sepIdx = rest.indexOf("|");
  if (sepIdx === -1) {
    await busReply(
      ctx,
      "Use <code>/prompts add &lt;label&gt; | &lt;text&gt;</code>.",
      "html",
    );
    return;
  }
  const label = rest.slice(0, sepIdx).trim();
  const text = rest.slice(sepIdx + 1).trim();
  if (!label || !text) {
    await busReply(ctx, "Need both label and text.", "html");
    return;
  }
  if (scoped && !sctx?.sessionName) {
    await busReply(
      ctx,
      "Use <code>add!</code> only inside a session topic.",
      "html",
    );
    return;
  }
  const p = await addPrompt({
    label,
    text,
    sessionScope: scoped ? sctx?.sessionName : undefined,
  });
  await busReply(
    ctx,
    `✅ saved <code>${escapeHtml(p.id)}</code> — <b>${escapeHtml(p.label)}</b>${scoped ? " 📌" : ""}`,
    "html",
  );
}

async function delCmd(ctx: Context, id: string): Promise<void> {
  if (!id) {
    await busReply(ctx, "Need a prompt id.", "html");
    return;
  }
  const ok = await removePrompt(id);
  await busReply(
    ctx,
    ok
      ? `🗑 removed <code>${escapeHtml(id)}</code>`
      : `❌ no prompt ${escapeHtml(id)}`,
    "html",
  );
}
