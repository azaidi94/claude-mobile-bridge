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
  /** Bot-side timeout — fires ~5s after MCP's so the MCP-side error wins. */
  expiryTimer?: ReturnType<typeof setTimeout>;
}

// In-memory map: ask_id → routing context. Bot restart drops these — the MCP
// will time out the corresponding tool calls, which is the right behavior.
const pendingAsks = new Map<string, PendingAsk>();

// One pending custom-text capture per (chat, thread) — keyed at thread
// granularity so a forum chat with many session topics doesn't have its
// sibling topics' typed messages hijacked by an open ask_remote in another
// topic. Concurrent asks in the SAME thread with allow_custom are rejected
// at request time (see postQuestionToTelegram) so the slot is never
// silently overwritten.
const customTextPending = new Map<string, string>(); // "chat|thread" → ask_id

function customKey(chatId: number, threadId: number | undefined): string {
  return `${chatId}|${threadId ?? 0}`;
}

const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 min — mirrors MCP default
const DEFAULT_TIMEOUT_OVERSHOOT_MS = 5_000;
let timeoutOvershootMs = DEFAULT_TIMEOUT_OVERSHOOT_MS;
const MAX_QUESTION_CHARS = 600;
const MAX_OPTION_LABEL_CHARS = 80;
const MAX_OPTION_DESC_CHARS = 240;

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

  // Reject a second concurrent ask_remote with allow_custom=true in the same
  // (chat, thread) — the customTextPending slot is single-valued per thread,
  // so silently letting the second overwrite the first would lose the user's
  // first answer. Different threads in the same chat are independent.
  if (req.allow_custom && customTextPending.has(customKey(chatId, threadId))) {
    throw new Error(
      `chat ${chatId} thread ${threadId ?? "(none)"} already has an ask_remote awaiting a custom-text answer; resolve or cancel that one first`,
    );
  }

  const trimmedQuestion = truncate(req.question, MAX_QUESTION_CHARS);
  const trimmedOptions = req.options.map((o) => ({
    label: truncate(o.label, MAX_OPTION_LABEL_CHARS),
    description:
      o.description !== undefined
        ? truncate(o.description, MAX_OPTION_DESC_CHARS)
        : undefined,
  }));

  const html = formatQuestion(trimmedQuestion, trimmedOptions);
  const keyboard = buildKeyboard(req.ask_id, trimmedOptions, req.allow_custom);

  const sent = await api.sendMessage(chatId, html, {
    parse_mode: "HTML",
    reply_markup: keyboard,
    ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
  });

  const sessionName = client.sessionName;

  // Bot-side timeout — overshoots the MCP-side timer by 5s so the
  // MCP's tool-result error reaches Claude first. If we win the race the
  // user sees an "expired" card and Claude sees an error too.
  const timeoutMs =
    (req.timeout_ms && req.timeout_ms > 0
      ? req.timeout_ms
      : DEFAULT_TIMEOUT_MS) + timeoutOvershootMs;
  const expiryTimer = setTimeout(() => {
    expirePendingAsk(req.ask_id);
  }, timeoutMs);

  pendingAsks.set(req.ask_id, {
    client,
    chatId,
    threadId,
    messageId: sent.message_id,
    options: trimmedOptions,
    allowCustom: req.allow_custom,
    question: trimmedQuestion,
    sessionName,
    expiryTimer,
  });

  // Mirror to the Web UI: any open session pane subscribed to this
  // sessionName's bus key sees the question as an interactive card.
  if (sessionName) {
    globalEventBus.emit(sessionName, {
      type: "ask_remote",
      content: trimmedQuestion,
      askId: req.ask_id,
      askQuestion: trimmedQuestion,
      askOptions: trimmedOptions,
      askAllowCustom: req.allow_custom,
    });
  }

  debug("relay-ask: posted question", {
    ask_id: req.ask_id,
    chat_id: chatId,
    thread_id: threadId,
    options: trimmedOptions.length,
    session: sessionName ?? "(unknown)",
    timeout_ms: timeoutMs,
  });
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function expirePendingAsk(askId: string): void {
  const entry = pendingAsks.get(askId);
  if (!entry) return;
  clearPending(askId, entry);
  if (botApi) {
    void editToFinal(botApi, entry, "⌛ Expired (no answer)");
  }
  emitCleared(entry, "expired", undefined, askId);
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
    clearPending(askId, entry);
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
    customTextPending.set(customKey(entry.chatId, entry.threadId), askId);
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
  clearPending(askId, entry);
  entry.client.sendAskRemoteAnswer({ ask_id: askId, answer: chosen });
  await api.answerCallbackQuery(callbackQueryId, {
    text: `Selected: ${chosen.slice(0, 40)}`,
  });
  await editToFinal(api, entry, `✅ ${chosen}`);
  emitCleared(entry, "answered", chosen, askId);
  return true;
}

/**
 * Try to consume a free-text message as a custom answer to a pending ask_remote
 * in the SAME (chat, thread). Returns true if the text was consumed (caller
 * should not process it further); false if no pending custom-input ask exists
 * for this exact thread. Sibling topics in the same chat aren't hijacked.
 */
export function tryConsumeCustomTextAnswer(
  chatId: number,
  threadId: number | undefined,
  text: string,
): boolean {
  const k = customKey(chatId, threadId);
  const askId = customTextPending.get(k);
  if (!askId) return false;
  const entry = pendingAsks.get(askId);
  if (!entry) {
    customTextPending.delete(k);
    return false;
  }
  clearPending(askId, entry);
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
  clearPending(askId, entry);
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
  clearPending(askId, entry);
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
  answer: string | undefined,
  askId: string,
): void {
  if (!entry.sessionName) return;
  globalEventBus.emit(entry.sessionName, {
    type: "ask_remote_cleared",
    content: "",
    askId,
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
  return truncate(s, 60);
}

/**
 * Free a pending ask: clear its bot-side timer + remove from the map. Called
 * by every resolution path (tap / web / cancel / custom-text / expiry) so the
 * timer never fires after the entry has already been resolved another way.
 */
function clearPending(askId: string, entry: PendingAsk): void {
  if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
  pendingAsks.delete(askId);
  customTextPending.delete(customKey(entry.chatId, entry.threadId));
}

// ── Test hooks ─────────────────────────────────────────────────────────

/** Test-only: clear all pending state (including any open timers). */
export function _resetForTests(): void {
  for (const [, entry] of pendingAsks) {
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
  }
  pendingAsks.clear();
  customTextPending.clear();
  botApi = null;
  timeoutOvershootMs = DEFAULT_TIMEOUT_OVERSHOOT_MS;
}

/**
 * Test-only: shrink the bot-side overshoot so timeout tests aren't slow.
 * Reset by _resetForTests.
 */
export function _setTimeoutOvershootForTests(ms: number): void {
  timeoutOvershootMs = ms;
}

/** Test-only: peek pending count. */
export function _pendingCountForTests(): number {
  return pendingAsks.size;
}
