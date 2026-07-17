/**
 * The gate between an inbound socket frame and an actual tool approval.
 *
 * `server.ts` cannot be imported by a test — it opens a TCP listener and speaks
 * MCP over stdio at module load — so this logic lives here, pure and testable.
 * It is the last thing standing between a frame on a localhost socket and a
 * `notifications/claude/channel/permission` that approves a shell command.
 *
 * Claude Code independently drops verdicts for ids it doesn't recognise, so
 * this is defence in depth rather than the only check. It exists so the relay
 * never emits a notification it cannot account for.
 */

export type PermissionBehavior = "allow" | "deny";

export class PermissionGate {
  private readonly forwarded = new Set<string>();

  /**
   * `max` only bounds memory for a long-lived session. Eviction drops the
   * oldest id, which is safe in a way worth stating: a session blocks on each
   * permission dialog, so it cannot accumulate anywhere near `max`
   * simultaneously-live prompts — by the time an id is the oldest of a full
   * set, its dialog was resolved (almost always at the desktop, which is what
   * leaves ids behind here) long ago.
   */
  constructor(private readonly max = 1000) {}

  /** Record a request_id we forwarded to the bot. */
  forward(id: string): void {
    if (this.forwarded.size >= this.max) {
      // Set iterates in insertion order, so this is FIFO.
      const oldest = this.forwarded.values().next().value;
      if (oldest !== undefined) this.forwarded.delete(oldest);
    }
    this.forwarded.add(id);
  }

  /**
   * Decide whether to emit a verdict for `id`. Returns the behavior to emit, or
   * null to drop the frame. Consumes the id, so a replayed frame is dropped.
   */
  accept(id: string, behavior: unknown): PermissionBehavior | null {
    if (behavior !== "allow" && behavior !== "deny") return null;
    if (!id || !this.forwarded.has(id)) return null;
    this.forwarded.delete(id);
    return behavior;
  }

  /** Test seam. */
  get size(): number {
    return this.forwarded.size;
  }
}
