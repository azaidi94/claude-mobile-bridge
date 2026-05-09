/**
 * Two-way ask_remote bridge — turns ask_remote tool calls from a relay-bridged
 * Claude session into a Telegram inline keyboard, then routes the user's tap
 * (or custom typed answer) back to the originating MCP server so the awaiting
 * tool call resolves.
 *
 * Why this exists:
 *   Native Claude Code AskUserQuestion blocks on the desktop TTY and isn't
 *   visible to the bridge until the user answers it locally. ask_remote
 *   sidesteps that — the question is delivered as a TG message, the answer
 *   round-trips through TCP, and Claude's tool result is the user's choice.
 */

import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import type { RelayClient, RelayAskRemoteRequest } from "../relay/client";
import { escapeHtml } from "../formatting";
import { BUTTON_LABEL_MAX_LENGTH } from "../config";
import { debug, warn } from "../logger";
import { globalEventBus } from "../web/sse";

interface PendingAsk {
  client: RelayClient;
  chatId: number;
  threadId?: number;
  messageId: number;
  options: { label: string; description?: string }[];
  allowCustom: boolean;
  question: string;
  /**
   * sessionName captured at request time so we can emit on the same bus key
   * (and therefore the same Web UI session pane) regardless of how the
   * answer arrives. May be undefined for sessions the registry hasn't seen.
   */
  sessionName?: string;
}

// In-memory map: ask_id → routing context. Bot restart drops these — the MCP
// will time out the corresponding tool calls, which is the right behavior.
const pendingAsks = new Map<string, PendingAsk>();

// One pending custom-text capture per chat. Next text in the chat resolves
// the latest open ask_remote that allowed custom input.
const customTextPending = new Map<number, string>(); // chatId → ask_id

let botApi: Api | null = null;

export function initRelayAsk(api: Api): void {
  botApi = api;
}

/**
 * Subscribe to ask_remote_request frames on a freshly-connected relay client.
 * Called once per RelayClient — registers a handler that posts a TG inline
 * keyboard on each request and stores enough context to route the answer back.
 */
export function attachAskRemoteToRelay(client: RelayClient): void {
  if (!botApi) {
    debug("relay-ask: skipping attach — botApi not yet initialized");
    return;
  }
  const api = botApi;
  client.onAskRemoteRequest(async (req) => {
    try {
      await postQuestionToTelegram(api, client, req);
    } catch (err) {
      warn("relay-ask: failed to post question", err, {
        ask_id: req.ask_id,
        chat_id: req.chat_id,
      });
      client.sendAskRemoteAnswer({
        ask_id: req.ask_id,
        error: `bot failed to deliver to Telegram: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

async function postQuestionToTelegram(
  api: Api,
  client: RelayClient,
  req: RelayAskRemoteRequest,
): Promise<void> {
  const chatId = Number(req.chat_id);
  if (!Number.isFinite(chatId)) {
    throw new Error(`invalid chat_id: ${req.chat_id}`);
  }
  const threadId =
    req.thread_id && Number.isFinite(Number(req.thread_id))
      ? Number(req.thread_id)
      : undefined;

  const html = formatQuestion(req.question, req.options);
  const keyboard = buildKeyboard(req.ask_id, req.options, req.allow_custom);

  const sent = await api.sendMessage(chatId, html, {
    parse_mode: "HTML",
    reply_markup: keyboard,
    ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
  });

  const sessionName = client.sessionName;
  pendingAsks.set(req.ask_id, {
    client,
    chatId,
    threadId,
    messageId: sent.message_id,
    options: req.options,
    allowCustom: req.allow_custom,
    question: req.question,
    sessionName,
  });

  // Mirror to the Web UI: any open session pane subscribed to this
  // sessionName's bus key sees the question as an interactive card.
  if (sessionName) {
    globalEventBus.emit(sessionName, {
      type: "ask_remote",
      content: req.question,
      askId: req.ask_id,
      askQuestion: req.question,
      askOptions: req.options,
      askAllowCustom: req.allow_custom,
    });
  }

  debug("relay-ask: posted question", {
    ask_id: req.ask_id,
    chat_id: chatId,
    thread_id: threadId,
    options: req.options.length,
    session: sessionName ?? "(unknown)",
  });
}

function formatQuestion(
  question: string,
  options: { label: string; description?: string }[],
): string {
  const lines: string[] = [];
  lines.push(`❓ <b>${escapeHtml(question)}</b>`);
  for (let i = 0; i < options.length; i++) {
    const o = options[i]!;
    const label = escapeHtml(o.label);
    if (o.description) {
      lines.push(`\n<b>${i + 1}. ${label}</b>\n${escapeHtml(o.description)}`);
    } else {
      lines.push(`\n<b>${i + 1}. ${label}</b>`);
    }
  }
  return lines.join("\n");
}

function buildKeyboard(
  askId: string,
  options: { label: string; description?: string }[],
  allowCustom: boolean,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < options.length; i++) {
    const label = options[i]!.label;
    const display =
      label.length > BUTTON_LABEL_MAX_LENGTH
        ? label.slice(0, BUTTON_LABEL_MAX_LENGTH - 1) + "…"
        : label;
    kb.text(display, `askremote:${askId}:${i}`).row();
  }
  if (allowCustom) {
    kb.text("✏️ Type a custom answer", `askremote:${askId}:custom`).row();
  }
  kb.text("✖ Cancel", `askremote:${askId}:cancel`);
  return kb;
}

/**
 * Handle a button tap with callback_data of shape `askremote:{ask_id}:{idx|custom|cancel}`.
 * Returns true if the callback was for ask_remote (consumed); false if not ours.
 */
export async function handleAskRemoteCallback(
  api: Api,
  callbackData: string,
  callbackQueryId: string,
  fromChatId: number,
): Promise<boolean> {
  if (!callbackData.startsWith("askremote:")) return false;
  const parts = callbackData.split(":");
  if (parts.length < 3) {
    await api.answerCallbackQuery(callbackQueryId, {
      text: "Invalid askremote payload",
    });
    return true;
  }
  const askId = parts[1]!;
  const action = parts[2]!;
  const entry = pendingAsks.get(askId);
  if (!entry) {
    await api.answerCallbackQuery(callbackQueryId, {
      text: "This question expired or was already answered.",
    });
    return true;
  }

  if (action === "cancel") {
    pendingAsks.delete(askId);
    customTextPending.delete(entry.chatId);
    entry.client.sendAskRemoteAnswer({
      ask_id: askId,
      error: "user cancelled",
    });
    await api.answerCallbackQuery(callbackQueryId, { text: "Cancelled" });
    await editToFinal(api, entry, "✖ Cancelled");
    emitCleared(entry, "cancelled", undefined, askId);
    return true;
  }

  if (action === "custom") {
    customTextPending.set(entry.chatId, askId);
    await api.answerCallbackQuery(callbackQueryId, {
      text: "Send your answer as a message in this chat.",
    });
    await editToWaiting(api, entry);
    return true;
  }

  const idx = Number(action);
  if (!Number.isInteger(idx) || idx < 0 || idx >= entry.options.length) {
    await api.answerCallbackQuery(callbackQueryId, { text: "Invalid option" });
    return true;
  }
  const chosen = entry.options[idx]!.label;
  pendingAsks.delete(askId);
  customTextPending.delete(entry.chatId);
  entry.client.sendAskRemoteAnswer({ ask_id: askId, answer: chosen });
  await api.answerCallbackQuery(callbackQueryId, {
    text: `Selected: ${chosen.slice(0, 40)}`,
  });
  await editToFinal(api, entry, `✅ ${chosen}`);
  emitCleared(entry, "answered", chosen, askId);
  // fromChatId is informational; we don't gate on it (button can only come
  // from the same chat the message was posted in).
  void fromChatId;
  return true;
}

/**
 * Try to consume a free-text message as a custom answer to a pending ask_remote.
 * Returns true if the text was consumed (caller should not process it further);
 * false if no pending custom-input ask exists in this chat.
 */
export function tryConsumeCustomTextAnswer(
  chatId: number,
  text: string,
): boolean {
  const askId = customTextPending.get(chatId);
  if (!askId) return false;
  const entry = pendingAsks.get(askId);
  if (!entry) {
    customTextPending.delete(chatId);
    return false;
  }
  customTextPending.delete(chatId);
  pendingAsks.delete(askId);
  entry.client.sendAskRemoteAnswer({ ask_id: askId, answer: text });
  if (botApi) {
    void editToFinal(botApi, entry, `✅ ${truncateForLabel(text)}`);
  }
  emitCleared(entry, "answered", text, askId);
  return true;
}

/**
 * Submit an answer that originated from the Web UI's POST endpoint. Mirrors
 * a button tap: routes to the MCP, edits the TG message to a final state,
 * and emits an ask_remote_cleared event so other Web UI tabs (and the same
 * tab) drop the card. Returns false if the askId is unknown / already resolved.
 */
export function submitAnswerFromWeb(askId: string, answer: string): boolean {
  const entry = pendingAsks.get(askId);
  if (!entry) return false;
  pendingAsks.delete(askId);
  customTextPending.delete(entry.chatId);
  entry.client.sendAskRemoteAnswer({ ask_id: askId, answer });
  if (botApi) {
    void editToFinal(botApi, entry, `✅ ${truncateForLabel(answer)}`);
  }
  emitCleared(entry, "answered", answer, askId);
  return true;
}

/**
 * Web-initiated cancel — same path as the TG cancel button.
 */
export function cancelAnswerFromWeb(askId: string): boolean {
  const entry = pendingAsks.get(askId);
  if (!entry) return false;
  pendingAsks.delete(askId);
  customTextPending.delete(entry.chatId);
  entry.client.sendAskRemoteAnswer({
    ask_id: askId,
    error: "user cancelled (web)",
  });
  if (botApi) {
    void editToFinal(botApi, entry, "✖ Cancelled");
  }
  emitCleared(entry, "cancelled", undefined, askId);
  return true;
}

function emitCleared(
  entry: PendingAsk,
  resolution: "answered" | "cancelled" | "timeout" | "expired",
  answer?: string,
  askId?: string,
): void {
  if (!entry.sessionName) return;
  globalEventBus.emit(entry.sessionName, {
    type: "ask_remote_cleared",
    content: "",
    askId: askId ?? "",
    askResolution: resolution,
    askAnswer: answer,
  });
}

async function editToFinal(
  api: Api,
  entry: PendingAsk,
  outcome: string,
): Promise<void> {
  try {
    await api.editMessageText(
      entry.chatId,
      entry.messageId,
      `${outcome}\n\n<i>${escapeHtml(entry.question)}</i>`,
      { parse_mode: "HTML" },
    );
  } catch (err) {
    debug("relay-ask: failed to edit message", { err: String(err) });
  }
}

async function editToWaiting(api: Api, entry: PendingAsk): Promise<void> {
  try {
    await api.editMessageText(
      entry.chatId,
      entry.messageId,
      `✏️ <b>Send your answer as a message.</b>\n\n<i>${escapeHtml(entry.question)}</i>`,
      { parse_mode: "HTML" },
    );
  } catch (err) {
    debug("relay-ask: failed to edit (waiting state)", { err: String(err) });
  }
}

function truncateForLabel(s: string): string {
  return s.length > 60 ? s.slice(0, 60) + "…" : s;
}

// ── Test hooks ─────────────────────────────────────────────────────────

/** Test-only: clear all pending state. */
export function _resetForTests(): void {
  pendingAsks.clear();
  customTextPending.clear();
  botApi = null;
}

/** Test-only: peek pending count. */
export function _pendingCountForTests(): number {
  return pendingAsks.size;
}
