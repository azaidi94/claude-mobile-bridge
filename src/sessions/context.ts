/**
 * SessionContext — the explicit per-handler session reference that replaces
 * the singleton `session` module and `getActiveSession()` global pointer.
 *
 * Phase 1 of the clean-architecture refactor. See
 * `docs/superpowers/plans/2026-05-25-phase-1-session-context.md`.
 *
 * Design:
 *   - Topic-first resolution. If the message arrives in a session topic,
 *     that's the session. No fallback to a global "current".
 *   - Returns `undefined` when the resolver genuinely doesn't know (private
 *     chat with no active session, General topic in a forum, etc.). The
 *     caller decides what to do — reply with help text, fall through to a
 *     legacy code path during migration, etc.
 *   - Immutable. Handlers receive the SessionContext by value; mutating it
 *     would be a bug. (The session registry is still mutable; this is just
 *     a frozen snapshot of "which session is this handler acting on".)
 *
 * During Phase 1's migration, handlers that haven't been migrated yet still
 * read the singleton. That's fine — the new path runs alongside the old
 * until the deletion step.
 */

import type { Context } from "grammy";
import { getSessionByTopic } from "../topics/topic-store";
import { getSession } from "./watcher";
import type { SessionInfo } from "./types";

/**
 * Thread id from either a message or callback-query context. Callbacks
 * fired from inline keyboards carry `message_thread_id` on the embedded
 * message, not on the synthetic `ctx.message`.
 */
function resolveThreadId(ctx: Context): number | undefined {
  const fromMessage = ctx.message?.message_thread_id;
  if (fromMessage !== undefined) return fromMessage;
  const cbMsg = ctx.callbackQuery?.message as
    | { message_thread_id?: number }
    | undefined;
  return cbMsg?.message_thread_id ?? undefined;
}

export interface SessionContext {
  /** Claude session UUID, or the synthetic `cursor-<slug>` id for Cursor. */
  readonly sessionId: string;
  /** Project working directory. */
  readonly sessionDir: string;
  /** Claude Code process PID, if known. Undefined for Cursor or unspawned. */
  readonly sessionPid?: number;
  /** Source of the session. */
  readonly source: "cc" | "cursor";
  /** Topic thread id within the chat, if the message is in a session topic. */
  readonly topicId?: number;
  /** Telegram chat the message arrived in. */
  readonly chatId: number;
  /** Human-friendly session name (slug). */
  readonly sessionName: string;
}

/**
 * Resolve a session context for the given grammy Context. Topic-first.
 *
 * Returns `undefined` when:
 *   - The chat is private / not a forum group
 *   - The message arrived in the General topic (thread_id 1 or undefined)
 *   - The topic exists but isn't mapped to a session in the topic store
 *   - The mapped session isn't in the registry
 *
 * Callers that need to act regardless of session (e.g. /list which works
 * everywhere) handle the undefined case themselves.
 */
export function resolveSessionContext(
  ctx: Context,
): SessionContext | undefined {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return undefined;

  const threadId = resolveThreadId(ctx);
  if (!threadId || threadId === 1) return undefined;

  const mapping = getSessionByTopic(threadId);
  if (!mapping) return undefined;

  const si: SessionInfo | null = getSession(mapping.sessionName);
  if (!si) return undefined;

  // The synthetic Cursor sessionId convention: Cursor sessions use their
  // session name as their id (e.g. "cursor-claude-mobile-bridge"). The CC
  // path uses a UUID. The `source` field disambiguates explicitly so callers
  // don't need to parse the id format — and Phase 5 will eventually fold
  // this into a typed `Session` implementation.
  const source: "cc" | "cursor" = si.source === "cursor" ? "cursor" : "cc";

  return {
    sessionId: si.id || "",
    sessionDir: si.dir,
    sessionPid: si.pid,
    source,
    topicId: mapping.topicId,
    chatId,
    sessionName: si.name,
  };
}

/**
 * Build a SessionContext directly from a SessionInfo. Used by code paths
 * that already hold a session (e.g. /switch landing on a specific session,
 * the watcher dispatching events to a session it knows about).
 *
 * `topicId` and `chatId` must be supplied — they're per-call, not per-session.
 */
export function sessionContextFromInfo(
  si: SessionInfo,
  chatId: number,
  topicId?: number,
): SessionContext {
  const source: "cc" | "cursor" = si.source === "cursor" ? "cursor" : "cc";
  return {
    sessionId: si.id || "",
    sessionDir: si.dir,
    sessionPid: si.pid,
    source,
    topicId,
    chatId,
    sessionName: si.name,
  };
}
