/**
 * Tool-header rendering: thinking previews, tool-use blocks, and
 * AskUserQuestion observation cards. Each event creates a new
 * `currentToolMsg` (deleting any prior one) and finalises any pending
 * streaming text segment.
 */

import type { Api } from "grammy";
import { escapeHtml, formatAskUserQuestion } from "../../formatting";
import { debug } from "../../logger";
import { getMessageBus } from "../../messaging";
import type { TailEvent } from "../../sessions/tailer";
import { busStubMessage, type TailDisplayState } from "./state";
import { finalizeTextMessage } from "./text-renderer";

export function renderThinking(
  _botApi: Api,
  state: TailDisplayState,
  event: TailEvent,
  threadId: number | undefined,
): void {
  const { chatId } = state;
  const trackProgress = (msg: import("grammy/types").Message) => {
    state.progressMessages?.push(msg);
  };

  const preview =
    event.content.length > 300
      ? event.content.slice(0, 300) + "..."
      : event.content;
  getMessageBus()
    .send({
      chatId,
      threadId,
      content: `🧠 <i>${escapeHtml(preview)}</i>`,
      format: "html",
      silent: true,
    })
    .then((r) => {
      if (!("messageId" in r)) return;
      const stub = busStubMessage(chatId, r.messageId);
      state.currentToolMsg = stub;
      trackProgress(stub);
    })
    .catch((err) => debug(`tail thinking: ${err}`));
}

export function renderTool(
  botApi: Api,
  state: TailDisplayState,
  event: TailEvent,
  threadId: number | undefined,
): void {
  const { chatId } = state;
  const trackProgress = (msg: import("grammy/types").Message) => {
    state.progressMessages?.push(msg);
  };

  // Register this tool_use so a later tool_result can look up its name.
  if (event.toolUseId && event.toolName) {
    if (!state.toolUseRegistry) state.toolUseRegistry = new Map();
    state.toolUseRegistry.set(event.toolUseId, event.toolName);
    // Bound the registry to last 100 entries to avoid unbounded growth.
    if (state.toolUseRegistry.size > 100) {
      const firstKey = state.toolUseRegistry.keys().next().value;
      if (firstKey !== undefined) state.toolUseRegistry.delete(firstKey);
    }
  }

  // Note: bookkeeping tools (TaskCreate/Update/Get/List/Stop/TodoWrite)
  // are suppressed on the WEB UI side via Terminal.tsx SUPPRESSED_TOOLS,
  // but rendered on Telegram so the rolling-status indicator continues to
  // tick during subagent-driven workflows. (Was previously suppressed in
  // both surfaces; user reverted Telegram side 2026-04-23 because it
  // killed the visible activity feedback in Telegram topics.)

  if (state.currentToolMsg) {
    // TODO(phase-2 delete): bus doesn't own deletions.
    botApi
      .deleteMessage(chatId, state.currentToolMsg.message_id)
      .catch(() => {});
    state.currentToolMsg = null;
  }
  if (state.currentTextMsg && !state.segmentDone) {
    finalizeTextMessage(botApi, state);
  }

  getMessageBus()
    .send({
      chatId,
      threadId,
      content: event.content,
      format: "html",
      silent: true,
    })
    .then((r) => {
      if (!("messageId" in r)) return;
      const stub = busStubMessage(chatId, r.messageId);
      state.currentToolMsg = stub;
      trackProgress(stub);
    })
    .catch((err) => debug(`tail tool: ${err}`));
}

export function renderAskUserQuestion(
  botApi: Api,
  state: TailDisplayState,
  event: TailEvent,
  threadId: number | undefined,
): void {
  const { chatId } = state;
  const trackProgress = (msg: import("grammy/types").Message) => {
    state.progressMessages?.push(msg);
  };

  // User still answers at the desktop's native picker; this is observe-only.
  if (state.currentToolMsg) {
    // TODO(phase-2 delete): bus doesn't own deletions.
    botApi
      .deleteMessage(chatId, state.currentToolMsg.message_id)
      .catch(() => {});
    state.currentToolMsg = null;
  }
  if (state.currentTextMsg && !state.segmentDone) {
    finalizeTextMessage(botApi, state);
  }
  const html = formatAskUserQuestion(event.questions ?? []);
  getMessageBus()
    .send({
      chatId,
      threadId,
      content: html,
      format: "html",
      silent: true,
    })
    .then((r) => {
      if (!("messageId" in r)) return;
      const stub = busStubMessage(chatId, r.messageId);
      state.currentToolMsg = stub;
      trackProgress(stub);
    })
    .catch((err) => debug(`tail ask_user_question: ${err}`));
}
