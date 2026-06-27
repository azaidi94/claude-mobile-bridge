/**
 * Re-export surface for the per-domain watch modules.
 *
 * `src/handlers/index.ts`, `src/relay/display.ts`, `src/web/routes/auq-bridge.ts`,
 * and the tests all import from `"./watch"` / `"../handlers/watch"`, which
 * resolves to this file. Decomposition is structural only — the public export
 * set matches the prior monolithic `watch.ts`.
 */

export type {
  MarkPendingResult,
  SseBus,
  TailDisplayState,
  WatchState,
} from "./state";
export { buildWatchState, isWatchState } from "./state";

export {
  _getWatchForTests,
  _registerWatchForTests,
  findWatchByDir,
  findWatchBySessionId,
  getWatch,
  isWatching,
  isWatchingAny,
} from "./registry";

export { _isTypingForTests } from "./typing";

export {
  _resolveLiveJsonlPath,
  _resolveDriftTargetId,
  _awaitSessionId,
  _isBackwardDriftTarget,
  _recoverMisboundTailer,
  inspectDirSiblings,
} from "./jsonl-tailer";

export { setupCrossPostSubscription } from "./cross-post";

export { bridgeTailToSse, handleTailEvent } from "./event-router";

export { maybeNotifyContextCrossing } from "./context-usage";

export { sendWatchRelay } from "./relay-replies";

export { flushBridgeReconnectSummaries } from "./offline-queue";

export {
  _handleIdleWatchForTests,
  clearPendingRunCompletion,
  formatRunElapsedLabel,
  markPendingRunCompletion,
  startWatchdog,
  stopWatchdog,
} from "./idle-watchdog";

export {
  _resetWatchesForTests,
  notifySessionOffline,
  stopWatchByName,
  stopWatching,
} from "./cleanup";

export { startAutoWatch, startWatchingSession } from "./session-builder";

export {
  handleUnwatch,
  handleWatch,
  startWatchingAndNotify,
} from "./lifecycle";

export { reassertSessionTopic } from "./rebind";
