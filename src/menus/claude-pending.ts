/**
 * Follow-up text for /claude menu taps on commands that take an argument
 * (e.g. /btw). The tap stores what we are waiting for, keyed by chat+thread;
 * the next text message in that topic completes the command instead of
 * being relayed as chat.
 */

export interface PendingClaudeArg {
  /** Command name without the slash. */
  name: string;
  createdAt: number;
}

export const PENDING_CLAUDE_ARG_TTL_MS = 10 * 60 * 1000;

/** pendingKey(chatId, threadId) → what the next message completes. */
export const pendingClaudeArg = new Map<string, PendingClaudeArg>();

export type PendingOutcome =
  | { kind: "cancel" }
  | { kind: "send"; slash: string; label: string };

/**
 * Consume a pending argument for `key` given the message just received.
 * Returns null when nothing is pending (or it expired). Always clears the
 * entry when it returns non-null.
 */
export function takePendingClaudeArg(
  key: string,
  message: string,
  now: number = Date.now(),
): PendingOutcome | null {
  const p = pendingClaudeArg.get(key);
  if (!p) return null;
  pendingClaudeArg.delete(key);
  if (now - p.createdAt > PENDING_CLAUDE_ARG_TTL_MS) return null;
  const text = message.trim();
  if (text === "/cancel" || text === "") return { kind: "cancel" };
  const slash = `/${p.name} ${text.replace(/[\r\n]+/g, " ")}`;
  return { kind: "send", slash, label: `➡️ Sent ${slash}.` };
}
