/**
 * /cron — list, add, delete, and enable/disable scheduled prompts.
 *
 *   /cron                          → list this topic's jobs (or all)
 *   /cron list                     → same
 *   /cron add <spec> <prompt>      → schedule a new job for this topic's session
 *   /cron del <id>                 → remove
 *   /cron on <id> | /cron off <id> → flip enabled
 *
 * <spec> is a 5-field cron expression evaluated in UTC, e.g.
 *   "0 9 * * *"     daily at 09:00 UTC
 *   "*\/5 * * * *"  every 5 minutes
 *   "0 12 * * 1-5"  weekdays at noon UTC
 */

import type { Context } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { isAuthorized } from "../../security";
import { parseCron } from "../../cron/parser";
import { getJobs, addJob, removeJob, setEnabled } from "../../cron/store";
import { escapeHtml } from "../../formatting";
import type { SessionContext } from "../../sessions/context";
import { busReply } from "./helpers";

const USAGE = [
  "<b>Usage:</b>",
  "<code>/cron list</code>",
  "<code>/cron add &lt;spec&gt; &lt;prompt&gt;</code>",
  "<code>/cron del &lt;id&gt;</code>",
  "<code>/cron on|off &lt;id&gt;</code>",
  "",
  "Spec is 5 UTC fields. Examples:",
  "<code>0 9 * * *</code> — daily 09:00 UTC",
  "<code>*/15 * * * *</code> — every 15m",
].join("\n");

export async function handleCron(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  const raw = ctx.message?.text ?? "";
  // Strip the command itself; preserve the rest verbatim including spaces.
  const args = raw.replace(/^\/cron(@\S+)?\s*/, "").trim();

  if (!args || args === "list") {
    await listJobs(ctx, sctx);
    return;
  }

  if (args.startsWith("add ")) {
    await addCmd(ctx, sctx, args.slice(4).trim());
    return;
  }
  if (args.startsWith("del ") || args.startsWith("rm ")) {
    const id = args.split(/\s+/)[1] ?? "";
    await delCmd(ctx, id);
    return;
  }
  if (args.startsWith("on ") || args.startsWith("off ")) {
    const [verb, id = ""] = args.split(/\s+/);
    await toggleCmd(ctx, id, verb === "on");
    return;
  }

  await busReply(ctx, USAGE, "html");
}

async function listJobs(ctx: Context, sctx?: SessionContext): Promise<void> {
  const all = await getJobs();
  const scoped = sctx?.sessionName
    ? all.filter((j) => j.sessionName === sctx.sessionName)
    : all;
  if (!scoped.length) {
    await busReply(
      ctx,
      sctx?.sessionName
        ? `No cron jobs for <b>${escapeHtml(sctx.sessionName)}</b>.\n\n${USAGE}`
        : `No cron jobs.\n\n${USAGE}`,
      "html",
    );
    return;
  }
  const lines = scoped.map((j) => {
    const flag = j.enabled ? "🟢" : "⚪";
    const last = j.lastRunAt
      ? ` <i>(last ${j.lastRunAt.slice(11, 16)}Z)</i>`
      : "";
    return `${flag} <code>${escapeHtml(j.id)}</code> <code>${escapeHtml(
      j.schedule,
    )}</code> → <b>${escapeHtml(j.sessionName)}</b>\n   ${escapeHtml(
      j.prompt.slice(0, 120),
    )}${last}`;
  });
  await busReply(ctx, `<b>Cron jobs</b>\n\n${lines.join("\n\n")}`, "html");
}

async function addCmd(
  ctx: Context,
  sctx: SessionContext | undefined,
  rest: string,
): Promise<void> {
  // Split into 5 spec tokens + the rest as the prompt.
  const tokens = rest.split(/\s+/);
  if (tokens.length < 6) {
    await busReply(ctx, "Need 5 spec fields + prompt.\n\n" + USAGE, "html");
    return;
  }
  const spec = tokens.slice(0, 5).join(" ");
  const prompt = tokens.slice(5).join(" ").trim();

  try {
    parseCron(spec);
  } catch (err) {
    await busReply(
      ctx,
      `❌ Invalid spec: <code>${escapeHtml(String(err))}</code>`,
      "html",
    );
    return;
  }

  if (!sctx?.sessionName) {
    await busReply(
      ctx,
      "Run <code>/cron add ...</code> inside a session topic so it knows where to send the prompt.",
      "html",
    );
    return;
  }

  const job = await addJob({
    schedule: spec,
    sessionName: sctx.sessionName,
    prompt,
    enabled: true,
  });
  await busReply(
    ctx,
    `✅ <code>${escapeHtml(job.id)}</code> <code>${escapeHtml(
      spec,
    )}</code> → <b>${escapeHtml(sctx.sessionName)}</b>`,
    "html",
  );
}

async function delCmd(ctx: Context, id: string): Promise<void> {
  if (!id) {
    await busReply(ctx, "Need a job id. Use <code>/cron list</code>.", "html");
    return;
  }
  const ok = await removeJob(id);
  await busReply(
    ctx,
    ok
      ? `🗑 Removed <code>${escapeHtml(id)}</code>`
      : `❌ No job ${escapeHtml(id)}`,
    "html",
  );
}

async function toggleCmd(ctx: Context, id: string, on: boolean): Promise<void> {
  if (!id) {
    await busReply(ctx, "Need a job id.", "html");
    return;
  }
  const ok = await setEnabled(id, on);
  await busReply(
    ctx,
    ok
      ? `${on ? "🟢 enabled" : "⚪ disabled"} <code>${escapeHtml(id)}</code>`
      : `❌ No job ${escapeHtml(id)}`,
    "html",
  );
}
