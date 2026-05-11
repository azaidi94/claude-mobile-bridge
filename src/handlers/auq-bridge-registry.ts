/**
 * In-memory registry of pending AUQ bridges. Pure data + waiter signalling;
 * no I/O. The orchestrator (`auq-bridge.ts`) and the HTTP route
 * (`web/routes/auq-bridge.ts`) both use this as their shared state.
 */

export interface AuqQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface AuqAnswer {
  question: string;
  answer: string;
}

export interface BridgeInit {
  requestId: string;
  toolUseId: string;
  sessionName: string;
  chatId: number;
  threadId: number;
  questions: AuqQuestion[];
  tmuxPane?: string;
}

export type BridgeResolution =
  | { status: "answered"; answers: AuqAnswer[] }
  | { status: "cancelled"; reason: string }
  | { status: "timeout" };

interface BridgeState extends BridgeInit {
  answers: AuqAnswer[];
  /** index of the question currently awaiting an answer (0-based). */
  currentIndex: number;
  /** Resolution if already set, else null. */
  resolution: BridgeResolution | null;
  /** Waiters subscribed via waitFor(). */
  waiters: Array<(r: BridgeResolution) => void>;
  /** Per-question per-surface TG card message ids, for editing on cancel. */
  tgMessageIds: Map<number, number>;
}

const bridges = new Map<string, BridgeState>();

export function register(init: BridgeInit): BridgeState {
  const state: BridgeState = {
    ...init,
    answers: [],
    currentIndex: 0,
    resolution: null,
    waiters: [],
    tgMessageIds: new Map(),
  };
  bridges.set(init.requestId, state);
  return state;
}

export function get(requestId: string): BridgeState | undefined {
  return bridges.get(requestId);
}

/** Resolve the bridge; idempotent — only the first call sticks. */
export function resolve(requestId: string, r: BridgeResolution): void {
  const b = bridges.get(requestId);
  if (!b || b.resolution) return;
  b.resolution = r;
  for (const w of b.waiters) w(r);
  b.waiters = [];
}

/**
 * Wait for the bridge's resolution. If already resolved, returns immediately.
 * Otherwise resolves on the next call to `resolve()` or after `timeoutMs`.
 */
export function waitFor(
  requestId: string,
  timeoutMs: number,
): Promise<BridgeResolution> {
  return new Promise((res) => {
    const b = bridges.get(requestId);
    if (!b) {
      res({ status: "cancelled", reason: "no such bridge" });
      return;
    }
    if (b.resolution) {
      res(b.resolution);
      return;
    }
    const timer = setTimeout(() => {
      const idx = b.waiters.indexOf(handler);
      if (idx >= 0) b.waiters.splice(idx, 1);
      res({ status: "timeout" });
    }, timeoutMs);
    const handler = (r: BridgeResolution) => {
      clearTimeout(timer);
      res(r);
    };
    b.waiters.push(handler);
  });
}

export function deleteEntry(requestId: string): void {
  // Resolve any pending waiters before removing the entry so callers
  // suspended on waitFor() unblock immediately rather than sitting on a
  // dead socket until the natural timeout. Without this, an HTTP-poll
  // disconnect would unhook the registry entry but leave the handler's
  // `await waitFor(id, waitMs)` running for up to 60s.
  const b = bridges.get(requestId);
  if (b && b.waiters.length > 0) {
    const cancelled: BridgeResolution = {
      status: "cancelled",
      reason: "deleted",
    };
    for (const w of b.waiters) w(cancelled);
    b.waiters = [];
  }
  bridges.delete(requestId);
}

export function _resetForTests(): void {
  bridges.clear();
}

export function _allForTests(): ReadonlyMap<string, BridgeState> {
  return bridges;
}
