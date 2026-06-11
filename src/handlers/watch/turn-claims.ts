/**
 * Per-turn delivery claim helpers for the relay→tailer dedup protocol.
 *
 * Protocol:
 *   Both the TCP relay path (relay-replies.ts) and the JSONL tailer
 *   (text-renderer.ts renderRelayReply) can see the same assistant reply.
 *   The first path to CLAIM the turn — synchronously, before its async
 *   send — wins. The other path sees the claim and skips. The claim lives
 *   in a Map on the per-watch TailDisplayState keyed by a hash of the
 *   reply text (turnClaimKey).
 *
 *   On TCP send failure (bus error or rate-limiter drop), the claim is
 *   released so the tailer fallback can still deliver the reply. Claims
 *   also auto-expire after CLAIM_TTL_MS so a missed release can never
 *   permanently suppress a future turn.
 *
 * Helpers take the raw Map<string, number> directly so they are pure
 * functions testable without any Telegram or grammY mocks.
 */

const CLAIM_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Build a stable claim key from reply content. Hashes the full text — a
 * plain prefix key collides when consecutive replies share a long common
 * header, silently suppressing the second reply.
 */
export function turnClaimKey(content: string): string {
  return `${content.length}:${Bun.hash(content).toString(36)}`;
}

/**
 * Synchronously claim a turn. Prunes expired entries as a side effect.
 *
 * MUST be called before the async send so the tailer sees the claim even
 * while the bus rate-limiter holds the send in its queue.
 */
export function claimTurn(claims: Map<string, number>, key: string): void {
  const now = Date.now();
  for (const [k, expiry] of claims) {
    if (expiry <= now) claims.delete(k);
  }
  claims.set(key, now + CLAIM_TTL_MS);
}

/**
 * Release a claim. Call when the TCP send fails so the tailer fallback can
 * still deliver the reply on this turn.
 */
export function releaseClaim(claims: Map<string, number>, key: string): void {
  claims.delete(key);
}

/**
 * Check whether the TCP path has claimed this turn and, if so, consume the
 * claim. Returns true when the turn is claimed and unexpired — the caller
 * (tailer) should skip its send. Expired claims are treated as absent
 * (returns false) so the tailer can deliver if TCP took too long.
 */
export function checkAndConsumeClaim(
  claims: Map<string, number>,
  key: string,
): boolean {
  const expiry = claims.get(key);
  if (expiry === undefined) return false;
  claims.delete(key);
  return expiry > Date.now();
}
