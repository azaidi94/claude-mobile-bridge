/**
 * Topic routing helpers.
 * Thin layer that resolves message context to topic/session mappings
 * and provides threadId injection for send methods.
 */

import type { Api, Context } from "grammy";
import {
  getTopicBySession,
  getSessionByTopic,
  removeTopicMapping,
} from "./topic-store";
import { warn } from "../logger";
import { session } from "../session";
import { getSession } from "../sessions";
import type { TopicMapping } from "../types";
import type { SessionOverride } from "../sessions/types";

/**
 * Check if the message is in the General topic (or no topic at all).
 * General topic has message_thread_id undefined or 1.
 */
export function isGeneralTopic(ctx: Context): boolean {
  const threadId = ctx.message?.message_thread_id;
  return threadId === undefined || threadId === 1;
}

/**
 * Check if the message is in a session topic.
 * Returns the session info if found, null otherwise.
 */
export function isSessionTopic(
  ctx: Context,
): { sessionName: string; topicId: number; mapping: TopicMapping } | null {
  const threadId = ctx.message?.message_thread_id;
  if (!threadId || threadId === 1) return null;

  const mapping = getSessionByTopic(threadId);
  if (!mapping) return null;

  return {
    sessionName: mapping.sessionName,
    topicId: mapping.topicId,
    mapping,
  };
}

export interface TopicSessionResult {
  threadId: number;
  sessionOverride?: SessionOverride;
}

/**
 * Resolve topic context and load the session.
 * Returns threadId and sessionOverride if in a session topic, undefined otherwise.
 */
export function loadTopicSession(ctx: Context): TopicSessionResult | undefined {
  const topicCtx = isSessionTopic(ctx);
  if (!topicCtx) return undefined;
  const si = getSession(topicCtx.sessionName);
  if (si) session.loadFromRegistry(si);
  return {
    threadId: topicCtx.topicId,
    sessionOverride: si
      ? { sessionId: si.id || "", sessionDir: si.dir, sessionPid: si.pid }
      : undefined,
  };
}

/**
 * Get the message_thread_id to use when sending to a session's topic.
 * Returns undefined if topics disabled or no mapping exists.
 */
export function getThreadId(sessionName: string): number | undefined {
  return getTopicBySession(sessionName)?.topicId;
}

/**
 * Extract threadId from a callback query context.
 */
export function getThreadIdFromCallback(ctx: Context): number | undefined {
  const msg = ctx.callbackQuery?.message;
  if (!msg) return undefined;
  return (msg as any).message_thread_id ?? undefined;
}

/**
 * Send a message with threadId, falling back to no thread on 400 errors.
 * Removes stale topic mapping if thread not found.
 */
export async function safeSendInThread(
  api: Api,
  chatId: number,
  text: string,
  threadId: number | undefined,
  opts?: Record<string, unknown>,
): Promise<any> {
  try {
    return await api.sendMessage(chatId, text, {
      ...opts,
      message_thread_id: threadId,
    });
  } catch (err) {
    if (threadId && String(err).includes("message thread not found")) {
      warn(`topic-router: stale thread ${threadId}, removing mapping`);
      const mapping = getSessionByTopic(threadId);
      if (mapping) removeTopicMapping(mapping.sessionName);
      return await api.sendMessage(chatId, text, opts);
    }
    throw err;
  }
}
