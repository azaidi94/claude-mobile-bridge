/**
 * In-flight relay-request registry (D3 of the origin-topic outbound refactor).
 *
 * While `sendViaRelay` owns a request-scoped tailer for session S, that tailer
 * already renders S's request-driven output to the origin topic. A *persistent*
 * auto-watch for S (bound elsewhere) tails the same JSONL and would render the
 * same turn a second time — the double-stream behind the misroute. Marking S
 * in-flight lets the auto-watch suppress its render for the duration, so it only
 * ever carries genuinely unsolicited output.
 *
 * Ref-counted so overlapping requests for one session don't unmask early, and
 * each unmark is idempotent so a double-call (e.g. cleanup running twice) can't
 * underflow the count.
 */

const inflight = new Map<string, number>();

/**
 * Mark `sessionName` as having an in-flight relay request. Returns an
 * idempotent unmark function — call it once the request completes.
 */
export function markRelayInflight(sessionName: string): () => void {
  inflight.set(sessionName, (inflight.get(sessionName) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (inflight.get(sessionName) ?? 0) - 1;
    if (next <= 0) inflight.delete(sessionName);
    else inflight.set(sessionName, next);
  };
}

/** True while at least one relay request is in flight for `sessionName`. */
export function isRelayInflight(sessionName: string): boolean {
  return (inflight.get(sessionName) ?? 0) > 0;
}

/** Test seam — clear all in-flight state. */
export function _resetInflightRelayForTests(): void {
  inflight.clear();
}
