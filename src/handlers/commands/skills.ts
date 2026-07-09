/**
 * /skills — search-first browser for Claude Code skills & slash commands.
 *
 *   /skills           → 🕘 recents (when any) + origin-group buttons
 *   /skills <query>   → substring match over name+description, paginated
 *
 * The landing is always actionable: with no recents yet, tappable origin
 * groups (⭐ Personal / 🧩 Plugins / 📌 Project) drill into paginated lists.
 *
 * Tapping a result opens a confirm card (see callback.ts "skill:" branches);
 * running it types "/name" into the live desktop TUI via sendKeysToSession,
 * exactly like /clear. Only cc-source sessions are injectable.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { isAuthorized } from "../../security";
import { escapeHtml } from "../../formatting";
import type { SessionContext } from "../../sessions/context";
import {
  discoverSkills,
  searchSkills,
  type SkillEntry,
} from "../../skills/discovery";
import { getRecents, recordUse } from "../../skills/recents";
import { busReply, resolveTopicSession } from "./helpers";
import type { InjectResult } from "./terminal-inject";

export const PAGE_SIZE = 8;
const RECENTS_MAX = 6; // two rows × 3
const RECENTS_PER_ROW = 3;

// pendingKey(chatId, threadId) -> skill name awaiting an args reply.
export const pendingSkillArgs = new Map<string, string>();

const BADGE: Record<SkillEntry["origin"], string> = {
  user: "⭐",
  project: "📌",
  plugin: "🧩",
};

/** Button label: badge + name, truncated to stay readable on a phone. */
export function skillLabel(e: SkillEntry): string {
  const name = e.name.length > 30 ? e.name.slice(0, 29) + "…" : e.name;
  return `${BADGE[e.origin]} ${name}`;
}

/**
 * Guard + resolve the injectable cc-session for this context. Returns the
 * SessionContext, or null when the caller should stop (already replied /
 * picker shown).
 */
async function requireCcSession(
  ctx: Context,
  sctx: SessionContext | undefined,
): Promise<SessionContext | null> {
  if (!sctx) {
    if (await resolveTopicSession(ctx, "skills_pick")) return null;
    await busReply(ctx, "Use /skills in a Claude session topic.");
    return null;
  }
  if (sctx.source !== "cc") {
    await busReply(
      ctx,
      `/skills isn't supported for ${sctx.source} sessions yet.`,
    );
    return null;
  }
  return sctx;
}

export async function handleSkills(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  if (!isAuthorized(ctx.from?.id, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  const session = await requireCcSession(ctx, sctx);
  if (!session) return;

  const raw = ctx.message?.text ?? "";
  const query = raw.replace(/^\/skills(@\S+)?\s*/, "").trim();

  if (query) {
    const built = buildSearch(session.sessionDir, query, 0);
    if (!built) {
      await busReply(ctx, `No skills match “${escapeHtml(query)}”.`, "html");
      return;
    }
    await busReply(ctx, built.text, {
      format: "html",
      replyMarkup: built.replyMarkup,
    });
    return;
  }
  const landing = await buildLanding(session.sessionDir);
  await busReply(ctx, landing.text, {
    format: "html",
    replyMarkup: landing.replyMarkup,
  });
}

const ORIGIN_GROUP: Array<{ origin: SkillEntry["origin"]; label: string }> = [
  { origin: "user", label: "⭐ Personal" },
  { origin: "plugin", label: "🧩 Plugins" },
  { origin: "project", label: "📌 Project" },
];

/**
 * Landing: 🕘 recents (two rows, when any) + origin-group buttons. Always
 * actionable — a fresh user with no recents still gets tappable groups to
 * browse instead of a dead text screen. Reused by the `skill:home` callback.
 */
export async function buildLanding(
  cwd: string,
): Promise<{ text: string; replyMarkup: InlineKeyboard }> {
  const all = discoverSkills(cwd);
  const indexByName = new Map(all.map((e, i) => [e.name, i]));
  const recentNames = await getRecents();
  const recents = recentNames
    .filter((n) => indexByName.has(n))
    .slice(0, RECENTS_MAX);

  const kb = new InlineKeyboard();
  if (recents.length > 0) {
    recents.forEach((name, i) => {
      const idx = indexByName.get(name)!;
      kb.text(skillLabel(all[idx]!), `skill:run:${idx}`);
      if ((i + 1) % RECENTS_PER_ROW === 0) kb.row();
    });
    // Only break to a fresh row if the last recents row is still open — else
    // the loop's `.row()` already opened one and a second wedges an empty row
    // (which Telegram can reject) between recents and the group buttons.
    if (recents.length % RECENTS_PER_ROW !== 0) kb.row();
  }

  // Group buttons — one per row, only origins that have entries.
  for (const { origin, label } of ORIGIN_GROUP) {
    const count = all.filter((e) => e.origin === origin).length;
    if (count > 0)
      kb.text(`${label} (${count})`, `skill:grp:${origin}:0`).row();
  }

  const recentHdr = recents.length > 0 ? "\n\n🕘 <b>Recent</b>" : "";
  const text =
    `<b>🧩 Skills</b> — ${all.length} available\n` +
    `Tap a group, or type <code>/skills &lt;query&gt;</code> to search.${recentHdr}`;
  return { text, replyMarkup: kb };
}

/**
 * Paginated list of one origin group. Reused by the `skill:grp:` callback.
 * Returns null if the origin has no entries.
 */
export function buildGroup(
  cwd: string,
  origin: SkillEntry["origin"],
  page: number,
): { text: string; replyMarkup: InlineKeyboard } | null {
  const all = discoverSkills(cwd);
  const matches = all
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.origin === origin);
  if (matches.length === 0) return null;

  const pages = Math.ceil(matches.length / PAGE_SIZE);
  const p = Math.max(0, Math.min(page, pages - 1));
  const slice = matches.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);

  const kb = new InlineKeyboard();
  for (const { e, i } of slice) kb.text(skillLabel(e), `skill:run:${i}`).row();
  if (pages > 1) {
    if (p > 0) kb.text("◀ Prev", `skill:grp:${origin}:${p - 1}`);
    kb.text(`${p + 1}/${pages}`, "skill:noop");
    if (p < pages - 1) kb.text("Next ▶", `skill:grp:${origin}:${p + 1}`);
    kb.row();
  }
  kb.text("⌂ Skills", "skill:home");

  const label = ORIGIN_GROUP.find((g) => g.origin === origin)?.label ?? origin;
  const text = `${label} — <b>${matches.length}</b> skill${matches.length === 1 ? "" : "s"}`;
  return { text, replyMarkup: kb };
}

/**
 * Build a search-results page. Pure — callers send (command) or edit
 * (pagination callback). Returns null when nothing matches.
 *
 * Button callback carries the entry's index in the full enumeration, so a tap
 * re-resolves against the same deterministic list regardless of the query.
 */
export function buildSearch(
  cwd: string,
  query: string,
  page: number,
): { text: string; replyMarkup: InlineKeyboard } | null {
  const all = discoverSkills(cwd);
  // Reuse searchSkills for the filter; indexOf recovers each match's position
  // in the full list (same object refs), giving a stable callback index.
  const matches = searchSkills(cwd, query).map((e) => ({
    e,
    i: all.indexOf(e),
  }));

  if (matches.length === 0) return null;

  const pages = Math.ceil(matches.length / PAGE_SIZE);
  const p = Math.max(0, Math.min(page, pages - 1));
  const slice = matches.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);

  const kb = new InlineKeyboard();
  for (const { e, i } of slice) {
    kb.text(skillLabel(e), `skill:run:${i}`).row();
  }
  if (pages > 1) {
    const q = pageQuery(query);
    if (p > 0) kb.text("◀ Prev", `skill:pg:${p - 1}:${q}`);
    kb.text(`${p + 1}/${pages}`, "skill:noop");
    if (p < pages - 1) kb.text("Next ▶", `skill:pg:${p + 1}:${q}`);
  }

  const text = `🔎 <b>${matches.length}</b> match${matches.length === 1 ? "" : "es"} for “${escapeHtml(query)}”`;
  return { text, replyMarkup: kb };
}

/**
 * Query fragment safe to embed in pagination callback_data. Telegram caps
 * callback_data at 64 *bytes*, so truncate by UTF-8 byte length (a CJK/emoji
 * query would blow the limit at far fewer than 40 code units). Leaves headroom
 * for the "skill:pg:<page>:" prefix.
 */
function pageQuery(query: string): string {
  const MAX_BYTES = 48;
  let q = query;
  while (Buffer.byteLength(q, "utf8") > MAX_BYTES) q = q.slice(0, -1);
  return q;
}

/**
 * Build the "/name [args]" line to type into the TUI. Collapses newlines: an
 * embedded Return would submit a partial command and type the rest as a
 * separate terminal line (or break osascript quoting).
 */
export function buildInjectLine(name: string, args: string): string {
  const clean = args.replace(/\s*\r?\n+\s*/g, " ").trim();
  return `/${name}${clean ? ` ${clean}` : ""}`;
}

/**
 * Inject "/name [args]" into the session's TUI and record the run on success.
 * Shared by the confirm-card "▶ Run" tap and the args reply handler.
 */
export async function runSkill(
  sctx: SessionContext,
  name: string,
  args: string,
): Promise<InjectResult> {
  const { sendKeysToSession } = await import("./terminal-inject");
  const result = await sendKeysToSession(sctx, buildInjectLine(name, args));
  if (result.ok) await recordUse(name);
  return result;
}
