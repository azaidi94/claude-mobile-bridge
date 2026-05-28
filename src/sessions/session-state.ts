/**
 * Per-session state container (Phase 1, task 7a).
 *
 * Mirrors the per-session fields that today live on the singleton
 * `ClaudeSession` in src/session.ts. This file is purely additive — the
 * singleton remains authoritative until subsequent task-7 sub-tasks
 * (7b–7g) wire SessionState into handlers and finally delete the
 * singleton.
 *
 * Instances are resolved by session name via `getSessionState(name)`,
 * which lazily creates and caches a SessionState in a module-level Map.
 */

import { getWorkingDir } from "../settings";
import type { PlanApprovalState, TokenUsage } from "../types";
import type { SessionInfo } from "./types";
import { debug, info } from "../logger";

export class SessionState {
  sessionId: string | null = null;
  // Nullable so the legacy singleton (ClaudeSession extends SessionState) can
  // start unnamed; resolver-created instances always have a concrete name.
  sessionName: string | null;
  workingDir: string;
  lastActivity: Date | null = null;
  lastMessage: string | null = null;
  lastError: string | null = null;
  lastErrorTime: Date | null = null;
  lastUsage: TokenUsage | null = null;
  lastTool: string | null = null;
  currentTool: string | null = null;
  queryStarted: Date | null = null;

  // Plan mode state
  isPlanMode = false;
  private _pendingPlanApproval: PlanApprovalState | null = null;

  // Per-query control fields
  abortController: AbortController | null = null;
  isQueryRunning = false;
  stopRequested = false;
  _isProcessing = false;
  _wasInterruptedByNewMessage = false;

  // Teardown callbacks (e.g. event-bus unsubscribes) run when this state is
  // dropped, so kill→recreate of the same session name doesn't stack listeners.
  private _cleanups: (() => void)[] = [];

  constructor(name: string | null = null) {
    this.sessionName = name;
    this.workingDir = getWorkingDir();
  }

  /**
   * Register a teardown fn invoked once when this state is dropped via
   * `dropSessionState`. Use for resources tied to the state's lifetime —
   * notably `globalEventBus.subscribe` unsubscribes attached in the
   * onSessionStateCreated hook.
   */
  registerCleanup(fn: () => void): void {
    this._cleanups.push(fn);
  }

  /** Run and clear all registered teardown callbacks. */
  runCleanups(): void {
    const fns = this._cleanups;
    this._cleanups = [];
    for (const fn of fns) {
      try {
        fn();
      } catch {
        // never let a misbehaving teardown block the drop
      }
    }
  }

  get isActive(): boolean {
    return this.sessionId !== null;
  }

  get isRunning(): boolean {
    return this.isQueryRunning || this._isProcessing;
  }

  get pendingPlanApproval(): PlanApprovalState | null {
    return this._pendingPlanApproval;
  }

  set pendingPlanApproval(state: PlanApprovalState | null) {
    this._pendingPlanApproval = state;
  }

  /**
   * Check if the last stop was triggered by a new message interrupt (! prefix).
   * Resets the flag when called. Also clears stopRequested so new messages can proceed.
   */
  consumeInterruptFlag(): boolean {
    const was = this._wasInterruptedByNewMessage;
    this._wasInterruptedByNewMessage = false;
    if (was) {
      this.stopRequested = false;
    }
    return was;
  }

  /**
   * Mark that this stop is from a new message interrupt.
   */
  markInterrupt(): void {
    this._wasInterruptedByNewMessage = true;
  }

  /**
   * Clear the stopRequested flag (used after interrupt to allow new message to proceed).
   */
  clearStopRequested(): void {
    this.stopRequested = false;
  }

  /**
   * Mark processing as started.
   * Returns a cleanup function to call when done.
   */
  startProcessing(): () => void {
    this._isProcessing = true;
    return () => {
      this._isProcessing = false;
    };
  }

  /**
   * Stop the currently running query or mark for cancellation.
   * Returns: "stopped" if query was aborted, "pending" if processing will be cancelled, false if nothing running
   */
  async stop(): Promise<"stopped" | "pending" | false> {
    if (this.isQueryRunning && this.abortController) {
      this.stopRequested = true;
      this.abortController.abort();
      debug("stop: aborting query");
      return "stopped";
    }

    if (this._isProcessing) {
      this.stopRequested = true;
      debug("stop: will cancel before query starts");
      return "pending";
    }

    return false;
  }

  /**
   * Kill the current session (clear session_id).
   */
  async kill(): Promise<void> {
    this.sessionId = null;
    this.lastActivity = null;
    this.workingDir = getWorkingDir();
    info("session cleared");
  }

  /**
   * Clear session ID only (preserves working dir, session name).
   * Used when switching models - starts fresh conversation but keeps context.
   */
  clearSession(): void {
    this.sessionId = null;
    this.lastActivity = null;
    debug("session cleared (model switch)");
  }

  /**
   * Set the working directory for this session.
   */
  setWorkingDir(dir: string): void {
    this.workingDir = dir;
    debug(`cwd: ${dir}`);
  }

  /**
   * Load session state from registry info.
   */
  loadFromRegistry(sessionInfo: SessionInfo): void {
    this.sessionId = sessionInfo.id || null;
    this.sessionName = sessionInfo.name;
    this.workingDir = sessionInfo.dir;
    this.lastActivity = sessionInfo.lastActivity
      ? new Date(sessionInfo.lastActivity)
      : null;
    info("session: loaded", {
      sessionName: sessionInfo.name,
      sessionId: sessionInfo.id,
      cwd: sessionInfo.dir,
      pid: sessionInfo.pid,
      source: sessionInfo.source,
    });
  }

  /**
   * Clear pending plan approval state.
   */
  clearPendingPlanApproval(): void {
    this._pendingPlanApproval = null;
  }
}

// ============== Resolver ==============

const states = new Map<string, SessionState>();
let onCreateHook: ((state: SessionState) => void) | null = null;

/**
 * Register a hook invoked once when a SessionState is first created via
 * `getSessionState`. Used by infra wireups (e.g. pinned-status mode-change
 * subscription in src/index.ts) to lazily attach per-session listeners
 * without coupling this module to the event bus. Pass `null` to clear.
 */
export function setOnSessionStateCreated(
  cb: ((state: SessionState) => void) | null,
): void {
  onCreateHook = cb;
}

/**
 * Resolve (and lazily create) a SessionState for the given session name.
 * Repeated calls with the same name return the same instance.
 */
export function getSessionState(name: string): SessionState {
  let state = states.get(name);
  if (!state) {
    state = new SessionState(name);
    states.set(name, state);
    try {
      onCreateHook?.(state);
    } catch {
      // never let a misbehaving hook break the resolver
    }
  }
  return state;
}

/**
 * Remove a SessionState from the map. Used by killSession cleanup. Runs the
 * state's teardown callbacks first so any per-session listeners (e.g. the
 * pinned-status event-bus subscription) are detached rather than orphaned.
 */
export function dropSessionState(name: string): void {
  states.get(name)?.runCleanups();
  states.delete(name);
}

/**
 * Snapshot of all live SessionStates (debug / web routes).
 */
export function listSessionStates(): SessionState[] {
  return Array.from(states.values());
}

/**
 * Test seam: nuke the SessionState map between tests so identity assertions
 * remain meaningful.
 */
export function _resetSessionStatesForTests(): void {
  for (const state of states.values()) state.runCleanups();
  states.clear();
}
