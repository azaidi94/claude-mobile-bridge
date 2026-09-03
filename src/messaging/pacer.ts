/**
 * Outbound pacer — enforces Telegram's per-chat flood limit.
 *
 * Wired as a grammy transformer in bot.ts, installed LAST so the pacer is the
 * OUTERMOST layer — grammy's `concatTransformer` wraps the existing chain, so
 * the last transformer installed is the first one called. Two properties
 * follow from that ordering and both matter:
 *
 *   - Nothing bypasses it. The MessageBus is not the only thing that talks to
 *     Telegram — `ctx.reply` in the SDK streaming path, permission cards,
 *     ask-cards, status messages and per-upload bubbles all call the raw Api.
 *     A limiter living in the bus throttles the disciplined callers while the
 *     loudest ones run unmetered, which is worse than no limiter at all.
 *   - autoRetry's backoff runs INSIDE the chat's slot. A 429 therefore stalls
 *     that chat's lane while it sleeps, instead of every other in-flight call
 *     racing into the same wall and each collecting its own 429.
 *
 * Model: two FIFO lanes per chat.
 *
 *   sends — `sendMessage` and friends, paced at CHAT_SEND_PER_MIN. This is the
 *     limit Telegram actually enforces on a group (~20/min), and it is shared
 *     across a forum's topics: they are one chat as far as the server is
 *     concerned.
 *   edits — `editMessageText` and friends, paced separately and far looser.
 *     Telegram treats edits far more permissively (every 429 observed in
 *     production was on sendMessage), and edits are the streaming heartbeat:
 *     charging them to the send budget would pace a live bubble at a fifth of
 *     STREAMING_THROTTLE_MS.
 *
 * Everything else (answerCallbackQuery, deleteMessage, pins, reactions,
 * sendChatAction, getUpdates…) passes straight through — those don't consume
 * the message budget, and queueing them behind it would strand callback
 * queries that expire in 15-30s.
 *
 * FIFO is the point, not a side effect. Calls leave in the order they were
 * issued, so a retried edit can't land after a newer one and rewind a
 * streaming bubble, and transcript blocks can't swap places.
 *
 * Waiting is bounded. A lane that has backed up past its deadline rejects the
 * call rather than holding the caller: almost everything here is awaited, much
 * of it inside `sequentialize` or a `ticking`-guarded loop, so an unbounded
 * wait doesn't delay one message — it stalls that topic's update queue, the
 * ralph monitor, or the boot reconcile behind it.
 */

import type { Api } from "grammy";
import { debug, warn } from "../logger";

// --- Tunables -------------------------------------------------------------

/**
 * Telegram's sustained group ceiling, shared across a forum's topics. Bursts
 * above it are tolerated, so each lane is a token bucket rather than a fixed
 * interval: BURST calls go out immediately, then the lane paces at PER_MIN.
 * Strict spacing would be both slower than Telegram allows and brittle —
 * a boot reconcile fanning out across every live session would shed sends it
 * could have delivered.
 */
export const CHAT_SEND_PER_MIN = 20;
export const CHAT_SEND_BURST = 20;
/**
 * Edits are cheap server-side but not free. The floor is one live stream's
 * cadence (60_000 / STREAMING_THROTTLE_MS = 120/min); this leaves headroom for
 * two topics streaming at once while still capping a runaway edit loop.
 */
export const CHAT_EDIT_PER_MIN = 300;
export const CHAT_EDIT_BURST = 30;

/**
 * How long a call may sit in its lane before we give up on it. Past this the
 * caller is better served by a fast failure it can log than by a promise that
 * resolves after the user has moved on — nearly everything here is awaited,
 * much of it inside `sequentialize` or a `ticking`-guarded loop.
 *
 * Not shorter for edits: an intermediate streaming edit is superseded by the
 * next one and safe to lose, but `finalizeTextMessage` is the ONLY writer of a
 * segment's complete text, and it fires at the end of a burst — exactly when
 * the lane is deepest. Dropping that one leaves a paragraph frozen mid-sentence.
 */
export const SEND_QUEUE_DEADLINE_MS = 30_000;
export const EDIT_QUEUE_DEADLINE_MS = 30_000;

/** Lane depth beyond which new calls are rejected immediately. */
export const MAX_LANE_DEPTH = 64;

/** Idle lanes are swept so a long-lived process doesn't accumulate them. */
const LANE_IDLE_TTL_MS = 5 * 60_000;

// --- Method classification ------------------------------------------------

/**
 * Methods that create a message, i.e. spend the chat's send budget. Media
 * groups count once per call; Telegram bills the album as one request.
 */
const SEND_METHODS = new Set([
  "sendMessage",
  "sendPhoto",
  "sendDocument",
  "sendVoice",
  "sendAudio",
  "sendVideo",
  "sendAnimation",
  "sendSticker",
  "sendMediaGroup",
  "sendLocation",
  "sendPoll",
  "sendDice",
  "sendContact",
  "copyMessage",
  "forwardMessage",
]);

const EDIT_METHODS = new Set([
  "editMessageText",
  "editMessageCaption",
  "editMessageMedia",
  "editMessageReplyMarkup",
]);

export type Lane = "send" | "edit";

export function laneFor(method: string): Lane | null {
  if (SEND_METHODS.has(method)) return "send";
  if (EDIT_METHODS.has(method)) return "edit";
  return null;
}

/**
 * The chat a call is billed to. `chat_id` covers everything we pace; a call
 * without one (inline-message edits) isn't chat-scoped and isn't paced.
 */
function chatIdOf(payload: unknown): string | null {
  const id = (payload as { chat_id?: number | string } | undefined)?.chat_id;
  return id === undefined ? null : String(id);
}

// --- Lane -----------------------------------------------------------------

interface LaneState {
  /** Tail of the FIFO. Each call chains onto the previous one. */
  tail: Promise<void>;
  tokens: number;
  /** ms epoch `tokens` was last brought up to date. */
  lastRefill: number;
  depth: number;
  lastUsedAt: number;
}

interface LaneSpec {
  capacity: number;
  refillPerMs: number;
  deadlineMs: number;
}

export interface PacerOptions {
  chatSendPerMin?: number;
  chatSendBurst?: number;
  chatEditPerMin?: number;
  chatEditBurst?: number;
  sendDeadlineMs?: number;
  editDeadlineMs?: number;
  maxLaneDepth?: number;
  /** Injectable for tests; defaults to the real clock and timer. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class PacerOverloadError extends Error {
  constructor(
    readonly method: string,
    readonly lane: Lane,
    readonly waitedMs: number,
  ) {
    super(
      `outbound ${lane} lane overloaded — ${method} dropped after ${waitedMs}ms`,
    );
    this.name = "PacerOverloadError";
  }
}

/**
 * Build the pacing function. Exported separately from the transformer so tests
 * can drive it without an Api instance.
 */
export function createPacer(opts: PacerOptions = {}) {
  const maxDepth = opts.maxLaneDepth ?? MAX_LANE_DEPTH;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));

  const specs: Record<Lane, LaneSpec> = {
    send: {
      capacity: opts.chatSendBurst ?? CHAT_SEND_BURST,
      refillPerMs: (opts.chatSendPerMin ?? CHAT_SEND_PER_MIN) / 60_000,
      deadlineMs: opts.sendDeadlineMs ?? SEND_QUEUE_DEADLINE_MS,
    },
    edit: {
      capacity: opts.chatEditBurst ?? CHAT_EDIT_BURST,
      refillPerMs: (opts.chatEditPerMin ?? CHAT_EDIT_PER_MIN) / 60_000,
      deadlineMs: opts.editDeadlineMs ?? EDIT_QUEUE_DEADLINE_MS,
    },
  };

  // `${lane}:${chatId}` → lane state.
  const lanes = new Map<string, LaneState>();

  function sweepIdleLanes(): void {
    const cutoff = now() - LANE_IDLE_TTL_MS;
    for (const [key, lane] of lanes) {
      // Only an idle lane with nothing queued is safe to forget — dropping a
      // busy one would hand it a full bucket and let a burst through.
      if (lane.depth === 0 && lane.lastUsedAt < cutoff) lanes.delete(key);
    }
  }

  function laneState(key: string, spec: LaneSpec): LaneState {
    let lane = lanes.get(key);
    if (!lane) {
      lane = {
        tail: Promise.resolve(),
        tokens: spec.capacity,
        lastRefill: now(),
        depth: 0,
        lastUsedAt: now(),
      };
      lanes.set(key, lane);
    }
    return lane;
  }

  /** Bring `tokens` up to date, clamped to the burst capacity. */
  function refill(st: LaneState, spec: LaneSpec): void {
    const t = now();
    const elapsed = t - st.lastRefill;
    if (elapsed <= 0) return;
    st.tokens = Math.min(spec.capacity, st.tokens + elapsed * spec.refillPerMs);
    st.lastRefill = t;
  }

  /** ms until the lane has a token, 0 if one is available now. */
  function waitForTokenMs(st: LaneState, spec: LaneSpec): number {
    refill(st, spec);
    if (st.tokens >= 1) return 0;
    return Math.ceil((1 - st.tokens) / spec.refillPerMs);
  }

  /**
   * Run `task` in the chat's lane: FIFO behind whatever is already queued, and
   * only once the lane's bucket yields a token. The lane stays held for the
   * task's whole duration.
   */
  async function pace<T>(
    lane: Lane,
    chatId: string,
    method: string,
    task: () => Promise<T>,
  ): Promise<T> {
    sweepIdleLanes();
    const spec = specs[lane];
    const key = `${lane}:${chatId}`;
    const st = laneState(key, spec);

    if (st.depth >= maxDepth) {
      warn("pacer: lane overloaded", {
        lane,
        chatId,
        method,
        depth: st.depth,
      });
      throw new PacerOverloadError(method, lane, 0);
    }

    const queuedAt = now();
    st.depth++;
    st.lastUsedAt = queuedAt;

    // Chain onto the tail BEFORE awaiting anything, so concurrent callers are
    // ordered by the tick they called in — that ordering is what keeps a
    // stale edit from landing after a newer one.
    const predecessor = st.tail;
    let release!: () => void;
    st.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await predecessor;

      const waitMs = waitForTokenMs(st, spec);
      const waitedSoFar = now() - queuedAt;
      if (waitedSoFar + waitMs > spec.deadlineMs) {
        warn("pacer: deadline exceeded", {
          lane,
          chatId,
          method,
          waitedMs: waitedSoFar,
          wouldWaitMs: waitMs,
        });
        throw new PacerOverloadError(method, lane, waitedSoFar + waitMs);
      }
      if (waitMs > 0) {
        await sleep(waitMs);
        refill(st, spec);
      }

      // Spend the token before the call, not after. The lane stays held for
      // the call's whole duration — autoRetry's 429 backoff runs inside this
      // task, and holding the lane through it is the point: no other call to
      // this chat walks into the same flood window.
      st.tokens -= 1;

      const totalWait = now() - queuedAt;
      if (totalWait > 0) {
        debug("pacer: paced", {
          lane,
          chatId,
          method,
          waitedMs: totalWait,
          depth: st.depth,
        });
      }
      return await task();
    } finally {
      st.depth--;
      st.lastUsedAt = now();
      release();
    }
  }

  return {
    pace,
    /** Test/introspection hook: current queue depth for a chat's lane. */
    depth(lane: Lane, chatId: string): number {
      return lanes.get(`${lane}:${chatId}`)?.depth ?? 0;
    },
  };
}

export type Pacer = ReturnType<typeof createPacer>;

/**
 * Install the pacer as a grammy transformer. Must be installed BEFORE
 * autoRetry so it wraps it — see the module header.
 */
export function installPacerTransformer(
  api: Api,
  opts: PacerOptions = {},
): Pacer {
  const pacer = createPacer(opts);

  api.config.use(async (prev, method, payload, signal) => {
    const lane = laneFor(method);
    const chatId = lane ? chatIdOf(payload) : null;
    if (!lane || chatId === null) {
      return prev(method, payload, signal);
    }
    return pacer.pace(lane, chatId, method, () =>
      prev(method, payload, signal),
    );
  });

  return pacer;
}
