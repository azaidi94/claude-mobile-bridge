/**
 * Topic routing helpers.
 * Thin layer that resolves message context to topic/session mappings
 * and provides threadId injection for send methods.
 */

import type { Context } from "grammy";
import { getTopicsEnabled } from "../settings";
import { getTopicBySession, getSessionByTopic } from "./topic-store";
import type { TopicMapping } from "../types";

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

/**
 * Get the message_thread_id to use when sending to a session's topic.
 * Returns undefined if topics disabled or no mapping exists.
 */
export function getThreadId(sessionName: string): number | undefined {
  if (!getTopicsEnabled()) return undefined;
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
