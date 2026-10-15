/**
 * Pull inbox — inbound delivery for sessions that can't receive channel
 * notifications.
 *
 * The Claude desktop app launches `claude` with its own fixed args, so
 * `--dangerously-load-development-channels` can't be passed and
 * `notifications/claude/channel` is dropped. The `bridge` plugin
 * (plugins/bridge; formerly channel-pull) long-polls this inbox over a Unix socket instead and
 * submits each message as a prompt.
 *
 * In such a session every inbound message lands here (a notification would be
 * dropped), queued until a poller drains it or it outlives MESSAGE_TTL_MS.
 */

export interface InboundMessage {
  content: string;
  meta: Record<string, string>;
}

/** A poller counts as active this long after its last poll ended. */
export const POLLER_GRACE_MS = 60_000;
/** Oldest messages drop past this — a dead poller must not grow memory. */
export const INBOX_CAP = 200;
/**
 * Queued messages expire with the relay's request ids (REQUEST_TTL_MS): past
 * it their `reply`/`ask_remote` would be refused, so a late poller gets only
 * what it can still answer.
 */
export const MESSAGE_TTL_MS = 600_000;

export type DropReason = "cap" | "expired";

export class PullInbox {
  private queue: { msg: InboundMessage; at: number }[] = [];
  private waiter: ((msgs: InboundMessage[]) => void) | null = null;
  private lastPollAt = 0;

  constructor(
    private now: () => number = Date.now,
    private onDrop: (
      reason: DropReason,
      msg: InboundMessage,
    ) => void = () => {},
  ) {}

  /** True when a poller is waiting or polled within the grace window. */
  isActive(): boolean {
    return (
      this.waiter !== null || this.now() - this.lastPollAt < POLLER_GRACE_MS
    );
  }

  enqueue(msg: InboundMessage): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      this.lastPollAt = this.now();
      w([msg]);
      return;
    }
    this.queue.push({ msg, at: this.now() });
    if (this.queue.length > INBOX_CAP)
      this.onDrop("cap", this.queue.shift()!.msg);
  }

  /**
   * Resolve with queued messages at once, or wait up to `timeoutMs` for the
   * next one. A newer poll supersedes a waiting one (it resolves empty), and
   * an aborted `signal` (the client hung up) resolves empty and stops waiting,
   * so no message is handed to a connection that's gone.
   */
  poll(timeoutMs: number, signal?: AbortSignal): Promise<InboundMessage[]> {
    this.lastPollAt = this.now();
    if (signal?.aborted) return Promise.resolve([]);
    this.dropExpired();
    if (this.queue.length) {
      const msgs = this.queue.map((q) => q.msg);
      this.queue = [];
      return Promise.resolve(msgs);
    }
    if (this.waiter) this.waiter([]);
    return new Promise((resolve) => {
      const finish = (msgs: InboundMessage[]) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(msgs);
      };
      const release = () => {
        if (this.waiter === finish) {
          this.waiter = null;
          this.lastPollAt = this.now();
        }
        finish([]);
      };
      const timer = setTimeout(release, timeoutMs);
      const onAbort = () => release();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiter = finish;
    });
  }

  private dropExpired(): void {
    const cutoff = this.now() - MESSAGE_TTL_MS;
    while (this.queue.length && this.queue[0]!.at < cutoff) {
      this.onDrop("expired", this.queue.shift()!.msg);
    }
  }
}

/**
 * Whether the parent `claude` was launched with channels enabled. When it was,
 * notifications work and the pull path stays off. Matches the flag only as a
 * whole argument (`--channels x`, `--channels=x`), never a longer flag.
 */
export function channelsEnabledIn(parentCommand: string): boolean {
  return /(?:^|\s)--(?:dangerously-load-development-)?channels(?:=|\s|$)/.test(
    parentCommand,
  );
}
