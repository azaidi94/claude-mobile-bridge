/**
 * Permission relay — mirrors a session's tool-approval prompts to its Telegram
 * topic and sends the tap back as a verdict.
 *
 * The desktop dialog stays live the whole time and Claude Code applies whichever
 * answer lands first, dropping the other. So this file never arbitrates: a tap
 * is just a second way to answer, and a tap that loses the race is a no-op.
 *
 * WHAT THE CARD MAY CLAIM. There is no ack anywhere in this path. A verdict is
 * a fire-and-forget notification, and Claude Code silently drops one for a
 * prompt that is already resolved — which is the common case, because answering
 * at the desktop leaves the card standing (nothing tells the bot it happened).
 * So a tap only ever proves "we sent it", never "it was applied", and the card
 * must say exactly that. Telling someone their `rm -rf` was denied when it had
 * already run is the worst thing this feature could do.
 *
 * Cards use their own `perm:*` callback namespace, the way `bridge:*` sits
 * beside `askremote:*`.
 *
 * See docs/superpowers/specs/2026-07-17-permission-relay-design.md.
 */

import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import { randomBytes } from "crypto";
import type { RelayClient, RelayPermissionRequest } from "../relay/client";
import { escapeHtml } from "../formatting";
import { debug, error as logError, info, warn } from "../logger";
import { topicForSession, getTopicStore } from "../topics/topic-store";
import { getSession } from "../sessions";
import { launchUuidForPid } from "../sessions/resolve-session";

const MAX_PREVIEW_CHARS = 700;
const MAX_DESCRIPTION_CHARS = 300;

interface PendingPermission {
  client: RelayClient;
  /** Claude Code's id for the prompt. Unique per session — NOT across them. */
  requestId: string;
  chatId: number;
  messageId: number;
  toolName: string;
  preview: string;
}

/**
 * Live cards, keyed by a bot-generated card token — NOT by request_id.
 *
 * request_id is five letters minted per session, so two concurrent sessions can
 * draw the same one. Keying this map by it let a tap on session A's card send
 * the verdict to session B's client: the user approves the command they are
 * looking at and a different, unseen command runs instead. The token is unique
 * across sessions and carries the client with it, so a tap can only ever answer
 * the prompt whose card it is on.
 */
const pending = new Map<string, PendingPermission>();

function newCardToken(): string {
  return randomBytes(6).toString("hex");
}

let botApi: Api | null = null;

export function initPermissionRelay(api: Api): void {
  botApi = api;
}

/** Test seam. */
export function _resetPermissionRelayForTests(): void {
  pending.clear();
  botApi = null;
}

/**
 * The command Claude wants to run, for display.
 *
 * `input_preview` is the tool's args as JSON-shaped text. For Bash that is
 * `{ "command": "…", "description": "…" }` and the bare command is what the
 * user is actually approving. For every other tool the args are the point —
 * unwrapping a `command` field there would silently hide its siblings (a
 * `{command: "sync", target: "prod"}` would render as just `sync`), so they are
 * shown whole.
 */
export function previewText(req: RelayPermissionRequest): string {
  const raw = req.input_preview.trim();
  if (raw) {
    if (req.tool_name === "Bash") {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const command = parsed.command;
        if (typeof command === "string" && command.trim()) {
          return command.trim();
        }
      } catch {
        /* not JSON, or not shaped as we expect — show it as-is */
      }
    }
    return raw;
  }
  // No preview at all: the description is all we have. It may be the bare
  // constant "Run shell command", which is useless but still better than blank.
  return req.description.trim();
}

/**
 * Newlines are preserved (unlike the `truncate` helpers in formatting.ts /
 * logger.ts, which flatten them) because the command renders inside a <pre> and
 * a multi-line script should read as one.
 */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (+${text.length - max} more)`;
}

export function formatPermissionCard(req: RelayPermissionRequest): string {
  const body = clamp(previewText(req), MAX_PREVIEW_CHARS);
  const header = `🔐 <b>Permission</b> — ${escapeHtml(req.tool_name)}`;
  // Both fields are model-controlled. Clamp before escaping, and clamp the
  // description too: escaping can expand it ~5x ("&" → "&amp;"), and an
  // oversized message makes sendMessage throw — which would silently suppress
  // the very card this feature exists to show.
  const desc = clamp(req.description.trim(), MAX_DESCRIPTION_CHARS);
  const showDesc = desc && desc !== body;
  return [
    header,
    ...(showDesc ? [escapeHtml(desc)] : []),
    `<pre>${escapeHtml(body)}</pre>`,
  ].join("\n\n");
}

function buildKeyboard(token: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Allow once", `perm:${token}:allow`)
    .text("🚫 Deny", `perm:${token}:deny`);
}

/**
 * Subscribe to permission_request frames on a freshly-connected relay client.
 * Mirrors attachAskRemoteToRelay. Safe to call before init — it no-ops.
 */
export function attachPermissionRelayToRelay(client: RelayClient): void {
  if (!botApi) {
    warn(
      "permission-relay: skipping attach — botApi not yet initialized (permission prompts will not reach Telegram on this client)",
      undefined,
      { session: client.sessionName, sessionDir: client.sessionDir },
    );
    return;
  }
  const api = botApi;
  debug("permission-relay: attached listener", {
    session: client.sessionName,
    sessionDir: client.sessionDir,
  });

  client.onPermissionRequest(async (req) => {
    try {
      await postPermissionCard(api, client, req);
    } catch (err) {
      // Never send a verdict on failure — the desktop dialog is still there and
      // is the only surface that should decide when we couldn't ask.
      logError("permission-relay: failed to post card", err, {
        session: client.sessionName,
      });
    }
  });

  // The session is gone, so its dialog is gone with it. Retire the cards or
  // they sit there looking tappable forever, and a tap would go nowhere.
  client.onDisconnect(() => {
    const orphans = [...pending].filter(([, p]) => p.client === client);
    if (orphans.length === 0) return;
    debug("permission-relay: retiring cards after relay disconnect", {
      count: orphans.length,
      session: client.sessionName,
    });
    for (const [token, p] of orphans) {
      pending.delete(token);
      void editCard(api, p, "✖ Session disconnected");
    }
  });
}

async function postPermissionCard(
  api: Api,
  client: RelayClient,
  req: RelayPermissionRequest,
): Promise<void> {
  // Topic-only by design: a permission card in General would be ambiguous about
  // which session it belongs to, and this card approves shell commands. No
  // topic → no card; the desktop dialog is still there.
  if (!client.sessionName) {
    debug("permission-relay: no sessionName on client, not posting", {
      request_id: req.request_id,
    });
    return;
  }
  const topic = topicForSession({
    launchUuid: launchUuidForPid(getSession(client.sessionName)?.pid),
    sessionName: client.sessionName,
  });
  if (!topic) {
    debug("permission-relay: no topic for session, not posting", {
      session: client.sessionName,
      request_id: req.request_id,
    });
    return;
  }
  // chatId lives on the store, not the mapping; 0 means the bot hasn't seen the
  // forum group yet.
  const chatId = getTopicStore().chatId;
  if (!chatId) {
    debug("permission-relay: no chatId known, not posting", {
      request_id: req.request_id,
    });
    return;
  }

  const token = newCardToken();
  const sent = await api.sendMessage(chatId, formatPermissionCard(req), {
    parse_mode: "HTML",
    reply_markup: buildKeyboard(token),
    message_thread_id: topic.topicId,
  });

  const entry: PendingPermission = {
    client,
    requestId: req.request_id,
    chatId,
    messageId: sent.message_id,
    toolName: req.tool_name,
    preview: clamp(previewText(req), MAX_PREVIEW_CHARS),
  };

  // The relay can drop while the send is in flight, in which case onDisconnect
  // already ran and saw nothing to retire. Registering now would leave a card
  // that is tappable forever against a session that no longer exists.
  if (!client.isConnected) {
    await editCard(api, entry, "✖ Session disconnected");
    return;
  }

  pending.set(token, entry);
  info("permission-relay: card posted", {
    session: client.sessionName,
    topic: topic.topicId,
    chatId,
    request_id: req.request_id,
    tool: req.tool_name,
  });
}

/**
 * Handle a `perm:<token>:<allow|deny>` tap. Returns false only when the
 * callback isn't ours, so the dispatcher can keep looking.
 */
export async function handlePermissionCallback(
  api: Api,
  callbackData: string,
  queryId: string,
): Promise<boolean> {
  if (!callbackData.startsWith("perm:")) return false;

  const parts = callbackData.split(":");
  const token = parts[1];
  const action = parts[2];
  if (
    parts.length !== 3 ||
    !token ||
    (action !== "allow" && action !== "deny")
  ) {
    // Ours but unparseable. Consume it: falling through would leave the tap
    // silently acked by the dispatcher's catch-all and the button spinning.
    await api.answerCallbackQuery(queryId, {
      text: "Invalid permission payload.",
    });
    return true;
  }

  const entry = pending.get(token);
  if (!entry) {
    // Already tapped, retired, or from a previous bot run.
    await api.answerCallbackQuery(queryId, {
      text: "This prompt is no longer waiting.",
    });
    return true;
  }
  pending.delete(token);

  const sent = entry.client.sendPermissionVerdict({
    request_id: entry.requestId,
    behavior: action,
  });
  if (!sent) {
    // Socket gone. Say so plainly rather than implying the answer landed —
    // the desktop dialog is still waiting for a human.
    await editCard(api, entry, "⚠️ Couldn't deliver — answer at the desktop");
    await api.answerCallbackQuery(queryId, {
      text: "Session not connected — answer at the desktop.",
    });
    return true;
  }

  info("permission-relay: verdict sent", {
    session: entry.client.sessionName,
    chatId: entry.chatId,
    request_id: entry.requestId,
    behavior: action,
  });
  // "sent", not "allowed": see the note at the top of this file. Edit the card
  // before the toast — if answerCallbackQuery throws on an expired query id,
  // the card must not be left showing live buttons for a verdict we already
  // sent.
  await editCard(
    api,
    entry,
    action === "allow" ? "✅ Allow sent" : "🚫 Deny sent",
  );
  await api.answerCallbackQuery(queryId, {
    text: action === "allow" ? "Allow sent" : "Deny sent",
  });
  return true;
}

async function editCard(
  api: Api,
  entry: PendingPermission,
  outcome: string,
): Promise<void> {
  try {
    await api.editMessageText(
      entry.chatId,
      entry.messageId,
      `${outcome} — <b>${escapeHtml(entry.toolName)}</b>\n\n<pre>${escapeHtml(entry.preview)}</pre>`,
      { parse_mode: "HTML" },
    );
  } catch (err) {
    debug("permission-relay: card edit failed", { err: String(err) });
  }
}
