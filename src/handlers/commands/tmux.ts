/**
 * Remote tmux control — /peek (capture-pane) + /tmux (button-driven panel:
 * list · peek · kill · start). Operates on the launcher's dedicated `-L claude`
 * socket (see scripts/tmux/launch.sh).
 *
 * Targeting is launchUuid-first: the panel rows and their inline buttons carry a
 * session's stable `launchUuid`, and each action re-resolves it to the CURRENT
 * tmux session/pane at tap time (via the live port-file + registry + list-panes
 * join), so a tap can never hit the wrong sibling even if things churn between
 * render and tap. Sessions with no launchUuid (non-hook) are listed read-only.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { ALLOWED_USERS } from "../../config";
import { isAuthorized } from "../../security";
import { scanPortFiles, type PortFileData } from "../../relay";
import { readRegistry, launchUuidByClaudePid } from "../../sessions/registry";
import { getTopicByLaunchUuid } from "../../topics/topic-store";
import { getMessageBus } from "../../messaging";
import { escapeHtml } from "../../formatting";
import { info, warn } from "../../logger";

const CC_SOCKET = "claude";
/**
 * Cap on the ESCAPED capture length. HTML-escaping can multiply a pane's raw
 * text several-fold (`<`→`&lt;`), so we must bound the escaped output, not the
 * raw, to stay under Telegram's 4096-char message limit (leaving room for the
 * `<pre>` wrapper + header).
 */
const CAPTURE_MAX_ESCAPED = 3800;

/**
 * Bus send that resolves the thread from EITHER a command (`ctx.message`) or a
 * button tap (`ctx.callbackQuery.message`) — `busReply` only reads the former,
 * so callback-context sends would misroute to General. Also gives us the bus's
 * 4096 truncation backstop.
 */
function reply(
  ctx: Context,
  content: string,
  opts:
    | "plain"
    | "html"
    | { format?: "plain" | "html"; replyMarkup?: InlineKeyboard } = "plain",
): Promise<unknown> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return Promise.resolve();
  const o = typeof opts === "string" ? { format: opts } : opts;
  return getMessageBus().send({
    chatId,
    threadId:
      ctx.message?.message_thread_id ??
      ctx.callbackQuery?.message?.message_thread_id,
    content,
    format: o.format ?? "plain",
    replyMarkup: o.replyMarkup?.inline_keyboard
      ? { inline_keyboard: o.replyMarkup.inline_keyboard }
      : undefined,
  });
}

// ── pure helpers (exported for tests) ───────────────────────────────────

/** One pane from `tmux list-panes -a` output. */
export interface PaneInfo {
  pane: string;
  session: string;
  attached: boolean;
}

/** A tmux-hosted Claude session, joined across tmux + port files + registry. */
export interface TmuxSessionRow {
  launchUuid?: string;
  tmuxSession: string;
  pane: string;
  cwd: string;
  attached: boolean;
  topicId?: number;
  /** Telegram topic name — how the user actually identifies this session. */
  topicName?: string;
}

/**
 * Parse `list-panes -a -F '#{pane_id},#{session_attached},#{session_name}'`.
 *
 * The delimiter is a COMMA, not a tab: tmux rewrites a literal TAB inside a
 * format string that contains `#{}` expansions into `_`, which silently made
 * every line unparseable. `pane_id` (`%N`) and `session_attached` (numeric) can
 * never contain a comma, so the free-form session name goes LAST and we re-join
 * any remaining parts — a comma inside a session name survives.
 */
export function parseTmuxPanes(stdout: string): PaneInfo[] {
  const out: PaneInfo[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(",");
    if (parts.length < 3) continue;
    const pane = parts[0]!;
    const attached = parts[1]!;
    const session = parts.slice(2).join(",");
    if (!pane || !session) continue;
    out.push({ pane, session, attached: (Number(attached) || 0) > 0 });
  }
  return out;
}

/**
 * Join alive port files (Claude sessions) with their tmux pane info, launchUuid
 * (registry, by claude pid = pf.ppid), and topic. Only sessions that (a) carry a
 * `tmuxPane` and (b) whose pane is still present in tmux are listed.
 */
export function buildTmuxRows(
  portFiles: PortFileData[],
  paneByPaneId: Map<string, PaneInfo>,
  launchUuidByPid: Map<number, string>,
  topicForUuid: (uuid: string) => { topicId: number; name: string } | undefined,
): TmuxSessionRow[] {
  const rows: TmuxSessionRow[] = [];
  for (const pf of portFiles) {
    if (!pf.tmuxPane) continue;
    const info = paneByPaneId.get(pf.tmuxPane);
    if (!info) continue; // pane gone from tmux → stale port file
    const launchUuid =
      pf.ppid !== undefined ? launchUuidByPid.get(pf.ppid) : undefined;
    const topic = launchUuid ? topicForUuid(launchUuid) : undefined;
    rows.push({
      launchUuid,
      tmuxSession: info.session,
      pane: pf.tmuxPane,
      cwd: pf.cwd,
      attached: info.attached,
      topicId: topic?.topicId,
      topicName: topic?.name,
    });
  }
  return rows;
}

export function listPanesArgs(): string[] {
  return [
    "tmux",
    "-L",
    CC_SOCKET,
    "list-panes",
    "-a",
    "-F",
    // Comma-delimited, free-form session name LAST — see parseTmuxPanes for why
    // a tab cannot be used here.
    "#{pane_id},#{session_attached},#{session_name}",
  ];
}

export function captureArgs(target: string): string[] {
  return ["tmux", "-L", CC_SOCKET, "capture-pane", "-p", "-t", target];
}

export function killArgs(session: string): string[] {
  return ["tmux", "-L", CC_SOCKET, "kill-session", "-t", session];
}

/**
 * HTML-escape a raw capture and fit it under `maxEscaped`, keeping the BOTTOM
 * (most recent) lines. Escaping happens FIRST so the returned length is the real
 * message length; when trimming, we cut to the next newline so a slice never
 * lands mid-entity (`&l` from `&lt;`), which would corrupt the HTML.
 */
export function fitEscapedCapture(
  text: string,
  maxEscaped = CAPTURE_MAX_ESCAPED,
): string {
  const esc = escapeHtml(text.replace(/\s+$/, ""));
  if (esc.length <= maxEscaped) return esc;
  const tail = esc.slice(esc.length - maxEscaped);
  const nl = tail.indexOf("\n");
  return "…\n" + (nl >= 0 ? tail.slice(nl + 1) : tail);
}

// ── IO seam ─────────────────────────────────────────────────────────────

function runTmux(argv: string[]): {
  ok: boolean;
  stdout: string;
  stderr: string;
} {
  try {
    const r = Bun.spawnSync(argv);
    return {
      ok: r.exitCode === 0,
      stdout: (r.stdout ?? Buffer.alloc(0)).toString(),
      stderr: (r.stderr ?? Buffer.alloc(0)).toString().trim(),
    };
  } catch (e) {
    // Bun.spawnSync THROWS on a missing binary (ENOENT) — e.g. tmux not on the
    // launchd PATH. Return an error instead of crashing the whole handler.
    return { ok: false, stdout: "", stderr: `tmux not runnable: ${String(e)}` };
  }
}

/**
 * `tmux list-panes` exits non-zero when NO server is running on the socket —
 * that's the legitimate "you have zero sessions" case (e.g. after
 * `tmux -L claude kill-server`), not a failure. Anything else (tmux missing from
 * PATH, socket permissions…) is a real error the user must see, rather than
 * being silently rendered as "no sessions".
 */
export function isNoServer(stderr: string): boolean {
  // Our own ENOENT wrapper (missing tmux binary) can contain "no such file or
  // directory" — that is a REAL failure, never "no server". Check it first.
  if (/not runnable/i.test(stderr)) return false;
  return /no server running|error connecting to/i.test(stderr);
}

export interface TmuxListResult {
  rows: TmuxSessionRow[];
  /** Set only when the tmux query genuinely failed (NOT "no server running"). */
  error?: string;
}

/** Live join → current tmux Claude-session rows. */
export async function listTmuxRows(): Promise<TmuxListResult> {
  const panesRes = runTmux(listPanesArgs());
  if (!panesRes.ok) {
    if (isNoServer(panesRes.stderr)) {
      // Legitimate zero-sessions, but log it — otherwise an empty panel is
      // indistinguishable from the bot querying the WRONG tmux socket/server.
      info("tmux: no server — 0 sessions", {
        socket: CC_SOCKET,
        stderr: panesRes.stderr.slice(0, 160),
      });
      return { rows: [] };
    }
    const error = panesRes.stderr.slice(0, 200) || "tmux query failed";
    warn("tmux: list-panes failed", { error });
    return { rows: [], error };
  }
  const paneByPaneId = new Map(
    parseTmuxPanes(panesRes.stdout).map((p) => [p.pane, p]),
  );
  // Only sessions on OUR socket: tmux pane ids (`%N`) are per-server, so a
  // session on a different socket (recorded in pf.tmuxSocket) whose pane id
  // collides with a `-L claude` pane would otherwise mis-join. The `-L claude`
  // socket file is named "claude".
  const allPortFiles = await scanPortFiles();
  const portFiles = allPortFiles.filter(
    (pf) => !pf.tmuxSocket || pf.tmuxSocket.endsWith(`/${CC_SOCKET}`),
  );
  const launchUuidByPid = launchUuidByClaudePid(readRegistry());
  const rows = buildTmuxRows(
    portFiles,
    paneByPaneId,
    launchUuidByPid,
    (uuid) => {
      const t = getTopicByLaunchUuid(uuid);
      return t ? { topicId: t.topicId, name: t.sessionName } : undefined;
    },
  );
  // Diagnostic: an empty panel has several distinct causes (no panes / no port
  // files / socket-filtered out / pane-id join miss). Log the shape of each
  // stage so it's never guesswork again.
  if (rows.length === 0) {
    info("tmux: 0 rows", {
      panes: paneByPaneId.size,
      paneIds: [...paneByPaneId.keys()].join(","),
      portFilesTotal: allPortFiles.length,
      portFilesOnClaudeSocket: portFiles.length,
      withTmuxPane: portFiles.filter((p) => p.tmuxPane).length,
      panesFromPortFiles: portFiles.map((p) => p.tmuxPane ?? "-").join(","),
      stdoutLen: panesRes.stdout.length,
    });
  }
  return { rows };
}

/** Resolve a launchUuid to its CURRENT row (or undefined if gone). */
async function rowForLaunchUuid(
  uuid: string,
): Promise<TmuxSessionRow | undefined> {
  return (await listTmuxRows()).rows.find((r) => r.launchUuid === uuid);
}

// ── rendering ───────────────────────────────────────────────────────────

/**
 * How the user identifies a session: its Telegram topic name. Falls back to
 * `<dir>-<pid>` (the tmux session's trailing pid disambiguates same-folder
 * siblings), then the short launchUuid — never a bare uuid when we can help it.
 */
export function rowLabel(r: TmuxSessionRow): string {
  if (r.topicName) return r.topicName;
  const dir = r.cwd.split("/").pop() || r.cwd;
  const pid = r.tmuxSession.split("-").pop();
  if (pid && /^\d+$/.test(pid)) return `${dir}-${pid}`;
  return r.launchUuid?.slice(0, 8) ?? r.tmuxSession;
}

/** Keep inline-button text short enough to stay readable on a phone. */
export function truncLabel(s: string, max = 20): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function renderPanelBody(rows: TmuxSessionRow[]): string {
  if (rows.length === 0) {
    return "🖥 <b>tmux sessions</b>\n\nNo Claude sessions running under tmux.";
  }
  const lines = rows.map((r, i) => {
    const dot = r.attached ? "🟢" : "⚪️";
    const noTopic = r.topicName ? "" : " <i>(no topic)</i>";
    // Row number ties the body entry to its buttons below.
    return (
      `<b>${i + 1}. ${escapeHtml(rowLabel(r))}</b>${noTopic}\n` +
      `   ${dot} <code>${escapeHtml(r.tmuxSession)}</code>`
    );
  });
  return `🖥 <b>tmux sessions</b>\n\n${lines.join("\n\n")}`;
}

/**
 * Panel keyboard: [🔍 <n>. <name>][💀 <n>] per launchUuid-bearing session, + Start.
 * The leading row number is what makes a button unambiguously belong to a row —
 * two same-folder siblings otherwise render identically.
 */
export function renderPanelKeyboard(rows: TmuxSessionRow[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const [i, r] of rows.entries()) {
    if (!r.launchUuid) continue; // non-hook session → read-only (no stable key)
    const n = i + 1;
    kb.text(`🔍 ${n}. ${truncLabel(rowLabel(r))}`, `tmux:peek:${r.launchUuid}`)
      .text(`💀 ${n}`, `tmux:kill:${r.launchUuid}`)
      .row();
  }
  kb.text("➕ Start session", "tmux:start");
  return kb;
}

// ── commands ────────────────────────────────────────────────────────────

function authed(ctx: Context): boolean {
  return isAuthorized(ctx.from?.id, ALLOWED_USERS);
}

/** /tmux — render the control panel. */
export async function handleTmux(ctx: Context): Promise<void> {
  if (!authed(ctx)) {
    await reply(ctx, "Unauthorized.");
    return;
  }
  const { rows, error } = await listTmuxRows();
  if (error) {
    await reply(
      ctx,
      `⚠️ tmux query failed: <code>${escapeHtml(error)}</code>\n\nIs <code>tmux</code> on the bot's PATH?`,
      "html",
    );
    return;
  }
  await reply(ctx, renderPanelBody(rows), {
    format: "html",
    replyMarkup: renderPanelKeyboard(rows),
  });
}

/** Capture a target session's screen and send it as a <pre> block. */
async function sendCapture(
  ctx: Context,
  row: TmuxSessionRow,
  edit: boolean,
): Promise<void> {
  const res = runTmux(captureArgs(row.pane));
  if (!res.ok) {
    const msg = `⚠️ capture-pane failed for <code>${escapeHtml(
      row.tmuxSession,
    )}</code>${res.stderr ? `: ${escapeHtml(res.stderr.slice(0, 120))}` : ""}`;
    if (edit)
      await ctx.editMessageText(msg, { parse_mode: "HTML" }).catch(() => {});
    else await reply(ctx, msg, "html");
    return;
  }
  const body = `🔍 <b>${escapeHtml(rowLabel(row))}</b>\n<pre>${fitEscapedCapture(
    res.stdout,
  )}</pre>`;
  const kb = new InlineKeyboard().text(
    "🔄 Refresh",
    `tmux:refresh:${row.launchUuid}`,
  );
  if (edit) {
    await ctx
      .editMessageText(body, { parse_mode: "HTML", reply_markup: kb })
      .catch(() => {});
  } else {
    await reply(ctx, body, { format: "html", replyMarkup: kb });
  }
}

/** /peek — capture the current topic's session (or the sole session). */
export async function handlePeek(ctx: Context): Promise<void> {
  if (!authed(ctx)) {
    await reply(ctx, "Unauthorized.");
    return;
  }
  const { rows, error } = await listTmuxRows();
  if (error) {
    await reply(ctx, `⚠️ tmux query failed: ${error}`);
    return;
  }
  const withUuid = rows.filter((r) => r.launchUuid);
  if (withUuid.length === 0) {
    await reply(ctx, "No tmux Claude session to peek.");
    return;
  }
  // In a session topic, prefer the row whose topic == this thread.
  const threadId = ctx.message?.message_thread_id;
  const match =
    (threadId ? withUuid.find((r) => r.topicId === threadId) : undefined) ??
    (withUuid.length === 1 ? withUuid[0] : undefined);
  if (!match) {
    await reply(
      ctx,
      "Multiple sessions — open /tmux and tap 🔍 on the one you want.",
    );
    return;
  }
  await sendCapture(ctx, match, false);
}

// ── callback dispatch (tmux:*) ──────────────────────────────────────────

/** Handle a `tmux:*` callback. `rest` is the callback data after `tmux:`. */
export async function handleTmuxCallback(
  ctx: Context,
  rest: string,
): Promise<void> {
  const [action, uuid] = rest.split(":");

  if (action === "start") {
    const { handleNew } = await import("./sessions");
    await ctx.answerCallbackQuery({ text: "Starting a session…" });
    await handleNew(ctx);
    return;
  }

  if (!uuid) {
    await ctx.answerCallbackQuery({ text: "Unknown session" });
    return;
  }
  const row = await rowForLaunchUuid(uuid);
  if (!row) {
    await ctx.answerCallbackQuery({ text: "Session gone." });
    return;
  }

  if (action === "peek" || action === "refresh") {
    await ctx.answerCallbackQuery().catch(() => {});
    await sendCapture(ctx, row, action === "refresh");
    return;
  }

  if (action === "kill") {
    await ctx.answerCallbackQuery().catch(() => {});
    const kb = new InlineKeyboard()
      .text("💀 Yes, kill", `tmux:killyes:${uuid}`)
      .text("Cancel", `tmux:killno:${uuid}`);
    await reply(
      ctx,
      `Kill <b>${escapeHtml(rowLabel(row))}</b>?\n<code>${escapeHtml(row.tmuxSession)}</code>\n\nThis ends the session.`,
      { format: "html", replyMarkup: kb },
    );
    return;
  }

  if (action === "killno") {
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    await ctx.editMessageText("Kill cancelled.").catch(() => {});
    return;
  }

  if (action === "killyes") {
    const res = runTmux(killArgs(row.tmuxSession));
    if (res.ok) {
      await ctx.answerCallbackQuery({ text: `Killed ${rowLabel(row)}` });
      await ctx
        .editMessageText(
          `💀 Killed <b>${escapeHtml(rowLabel(row))}</b> (<code>${escapeHtml(row.tmuxSession)}</code>).`,
          {
            parse_mode: "HTML",
          },
        )
        .catch(() => {});
    } else {
      warn("tmux: kill failed", { stderr: res.stderr });
      await ctx.answerCallbackQuery({ text: "Kill failed." });
    }
    return;
  }

  await ctx.answerCallbackQuery({ text: "Unknown action" });
}
