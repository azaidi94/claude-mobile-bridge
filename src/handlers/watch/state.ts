/**
 * Watch + relay-display state shapes. Pure types/factories — no side effects,
 * no module-level state. Anyone needing to construct or refine a WatchState
 * imports from here.
 */

import type { Message } from "grammy/types";
import type { SessionTailer } from "../../sessions/tailer";
import type { SseEvent } from "../../web/sse";

// ============== SSE Bridge ==============

export interface SseBus {
  emit(sessionId: string, event: SseEvent): void;
}

// ============== Shared Tail Display State ==============

/** Common display state used by both /watch and relay display pipelines. */
export interface TailDisplayState {
  chatId: number;
  currentToolMsg: Message | null;
  currentTextMsg: Message | null;
  currentTextContent: string;
  lastTextUpdate: number;
  segmentDone: boolean;
  /** Optional: track messages for bulk cleanup (used by relay). */
  progressMessages?: Message[];
  /** Optional: stop showing progress after final reply (used by relay). */
  finalReplyReceived?: boolean;
  /** Watch-only: maps toolUseId → toolName for tool_result correlation. */
  toolUseRegistry?: Map<string, string>;
  /**
   * The most recent native AskUserQuestion observation card still awaiting its
   * answer. When the matching tool_result lands (answered at the desktop), the
   * card is edited into a resolved "✅ Answered" state so Telegram doesn't drift
   * out of sync with the local terminal. Cleared once finalized.
   */
  pendingAskCard?: {
    messageId: number;
    toolUseId: string;
    questions: import("../../types").AskUserQuestionItem[];
  };
  /** Watch-only: last permission mode emitted (for dedup). */
  lastPermissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  /**
   * Per-turn delivery claims for the relay→tailer dedup protocol.
   * Key: turnClaimKey(reply text). Value: expiry timestamp (ms).
   * The TCP path claims a turn synchronously before its send; the tailer
   * skips any turn whose key is present and unexpired. On TCP send failure
   * the claim is released so the tailer can still deliver.
   * See turn-claims.ts for the full protocol.
   */
  relayReplyClaims?: Map<string, number>;
  /**
   * True while a new text-bubble send is in flight (bus.send not yet
   * resolved). Guards renderText against opening a second bubble while
   * the first send is still queued on the bus rate-limiter.
   */
  textMsgPending?: boolean;
}

// ============== Watch State ==============

export interface WatchState extends TailDisplayState {
  sessionName: string;
  sessionId: string;
  sessionDir: string;
  sessionPid?: number;
  /** Assigned in a second step so the tailer can close over `watchState`. Reads must use `?.`. */
  tailer?: SessionTailer;
  lastEventTime: number;
  /** Topic thread ID — all messages go to this thread. */
  threadId: number;
  /** Cleanup function to remove relay callbacks when watch stops. */
  relayCleanup?: () => void;
  /** Interval that detects when the desktop session starts a new conversation. */
  idCheckInterval?: Timer;
  /**
   * Spawn-initiated watches seed `sessionId` with the most-recent JSONL
   * fallback (watcher.ts:347), because the freshly-launched claude process
   * hasn't written its real JSONL yet. The first id-change in
   * `idCheckInterval` is therefore the arrival of the real id, not a
   * genuine conversation switch — suppress the "reconnected" broadcast
   * once, then resume normal behavior.
   */
  suppressNextIdChangeNotice?: boolean;
  /**
   * Highest context-usage threshold bucket already notified on this watch.
   * Zero means none fired yet (or bucket was reset after a compact).
   */
  lastNotifiedBucket?: number;
  /**
   * Set by /run when the user fired an async task. The next turn-completion
   * event (relay_reply, hook_summary, or extended idle) sends a
   * notification ping with the elapsed time. Cleared after firing.
   */
  pendingRunCompletion?: { startedAt: number; prompt: string };
  /**
   * Tail events dropped while the TG bridge was offline. Flushed as one
   * summary message when bridge-health flips back to online.
   */
  skippedWhileOffline?: number;
  /**
   * True when the last JSONL event was assistant text/tool/thinking — i.e.
   * Claude is "mid-turn" from the watchdog's perspective. Cleared on user /
   * relay_reply / turn_boundary so the idle clock only runs while Claude
   * owes the user something.
   */
  midTurn?: boolean;
  /**
   * Per-state suppression so the watchdog only fires once per stuck turn.
   * Re-armed when activity resumes.
   */
  watchdogFired?: boolean;
  unsubCrossPost?: () => void;
  /**
   * True when the tailer was started against a guessed/expected JSONL path
   * (i.e. `findSessionJsonlPath` returned null at startup, so the path is
   * `getExpectedJsonlPath(dir, id)` which may never get written if CC chose
   * a different uuid than the relay port file's id). The drift-detection
   * interval runs more aggressively while this flag is set, and clears it
   * once a real on-disk JSONL is bound.
   */
  speculativeTailerPath?: boolean;
}

/**
 * Distinguish a WatchState from a relay-display TailDisplayState. Checks the
 * combination of fields that only WatchState carries — `"lastEventTime" in`
 * alone would silently match any future TailDisplayState subtype that gains
 * that field.
 */
export function isWatchState(state: TailDisplayState): state is WatchState {
  return (
    "lastEventTime" in state && "tailer" in state && "sessionName" in state
  );
}

export function buildWatchState(args: {
  sessionName: string;
  sessionId: string;
  sessionDir: string;
  sessionPid?: number;
  chatId: number;
  threadId: number;
  suppressNextIdChangeNotice?: boolean;
}): WatchState {
  return {
    sessionName: args.sessionName,
    sessionId: args.sessionId,
    sessionDir: args.sessionDir,
    sessionPid: args.sessionPid,
    chatId: args.chatId,
    threadId: args.threadId,
    lastEventTime: Date.now(),
    currentToolMsg: null,
    currentTextMsg: null,
    currentTextContent: "",
    lastTextUpdate: 0,
    segmentDone: true,
    ...(args.suppressNextIdChangeNotice
      ? { suppressNextIdChangeNotice: true }
      : {}),
  };
}

/**
 * Result of arming a pending /run completion. Exported for callers (commands/run)
 * that surface "already-pending" to the user.
 */
export type MarkPendingResult = "armed" | "no-watch" | "already-pending";

/**
 * Build a minimal grammy `Message`-shaped stub from a bus `messageId`. The
 * watch display state only ever reads `.message_id` (for edits/deletes) and
 * `.chat.id` (for delete targets) — so a stub is sufficient. Centralised here
 * so phase-2 step-4 has one place to revisit if the bus ever returns a richer
 * object.
 */
export function busStubMessage(chatId: number, messageId: number): Message {
  return { message_id: messageId, chat: { id: chatId } } as Message;
}
