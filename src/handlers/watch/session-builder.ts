/**
 * Watch-session builders: `startWatchingSession` (manual /watch + /switch),
 * `startAutoWatch` (auto-watch on topic creation), plus the shared
 * conflict-resolution helper.
 *
 * Both builders share the same skeleton: poll for a session id, resolve the
 * live JSONL path, build a WatchState, attach a tailer that pipes events into
 * the router + SSE bridge, wire the drift detector + cross-post subscription
 * + relay reply binding. Cleanup (`stopWatching`) lives in `lifecycle.ts`.
 */

import type { Api } from "grammy";
import { debug, error, info } from "../../logger";
import { safeSync } from "../../utils/safe-async";
import {
  forceRefresh,
  getSession,
  updateSessionId,
  updatePinnedStatus,
  getGitBranch,
} from "../../sessions";
import { getCurrentModelDisplayName } from "../../session";
import { SessionTailer } from "../../sessions/tailer";
import { getRelayClient } from "../../relay";
import { getMessageBus } from "../../messaging";
import { stopWatching } from "./cleanup";
import { setupCrossPostSubscription } from "./cross-post";
import { makeWatchTailHandler } from "./tail-handler";
import {
  _awaitSessionId,
  _resolveLiveJsonlPath,
  inspectDirSiblings,
  setupIdDriftDetection,
} from "./jsonl-tailer";
import { watchKey, watches } from "./registry";
import { bindRelayReplyHandler } from "./relay-replies";
import { buildWatchState, type WatchState } from "./state";

/**
 * Resolve an existing watch against the caller's intended session.
 * Returns true if the caller should abort (topic bound to a different
 * session); otherwise stops any same-name watch so the caller can rebuild.
 */
function resolveAutoWatchConflict(
  botApi: Api,
  chatId: number,
  threadId: number,
  sessionName: string,
  phase: "already" | "now",
): boolean {
  const existing = watches.get(watchKey(chatId, threadId));
  if (!existing) return false;
  if (existing.sessionName !== sessionName) {
    info("auto-watch: skipped, topic bound to different session", {
      phase,
      chatId,
      threadId,
      requestedSession: sessionName,
      currentSession: existing.sessionName,
    });
    return true;
  }
  stopWatching(chatId, threadId, botApi, "auto-replace");
  return false;
}

/**
 * Start auto-watching a session in a topic.
 * Called by topic manager when a topic is created and session is online.
 */
export async function startAutoWatch(
  botApi: Api,
  chatId: number,
  threadId: number,
  sessionName: string,
): Promise<boolean> {
  // Auto-watch loses to user intent — both for pre-existing /watch bindings
  // and for /watch races that land while we're waiting on the session id.
  if (
    resolveAutoWatchConflict(botApi, chatId, threadId, sessionName, "already")
  ) {
    return false;
  }

  // Cursor sessions have no JSONL/relay — the cursor-bridge owns
  // cross-posting via wireCrossPost in src/cursor/index.ts. Setting up
  // a watch here would just register a second bus subscription on the
  // same session and double-post user messages.
  const existingInfo = getSession(sessionName);
  if (existingInfo?.source === "cursor") {
    return false;
  }

  const sessionInfo = await _awaitSessionId(sessionName);
  if (!sessionInfo?.id) {
    debug("auto-watch: start failed, missing session id after retries", {
      chatId,
      threadId,
      sessionName,
    });
    return false;
  }

  if (resolveAutoWatchConflict(botApi, chatId, threadId, sessionName, "now")) {
    return false;
  }

  // Final liveness check: session may have been killed while we awaited the
  // id. Without this, a kill callback racing with startup reconcile can land
  // an orphan watch in the map — its sessionDir then mutes drift detection
  // for any sibling watch via the "sole owner" guard.
  if (!getSession(sessionName)) {
    info("auto-watch: session disappeared during setup, aborting", {
      chatId,
      threadId,
      sessionName,
    });
    return false;
  }

  // When a sibling session shares this dir, never let the resolver adopt the
  // newest-in-dir JSONL — it's the sibling's, not this freshly-spawned one.
  const { excludeIds, hasSibling } = await inspectDirSiblings(
    sessionInfo.dir,
    sessionInfo.id,
  );
  const resolved = await _resolveLiveJsonlPath(sessionInfo, {
    excludeIds,
    allowNewestInDirFallback: !hasSibling,
  });
  const jsonlPath = resolved.path;

  const watchState: WatchState = buildWatchState({
    sessionName,
    sessionId: resolved.sessionId,
    sessionDir: sessionInfo.dir,
    sessionPid: sessionInfo.pid,
    chatId,
    threadId,
  });
  watchState.speculativeTailerPath = resolved.speculative;
  // If the resolver picked up an id that differs from what the registry
  // had (CC wrote its real JSONL under a different uuid than the relay
  // port file reported), sync the registry so other lookups see the
  // canonical id.
  if (resolved.sessionId !== sessionInfo.id) {
    safeSync(
      "watch.update_session_id",
      () => updateSessionId(sessionName, resolved.sessionId),
      { severity: "debug" },
    );
  }
  const tailer = new SessionTailer(
    jsonlPath,
    makeWatchTailHandler(botApi, watchState),
  );
  watchState.tailer = tailer;
  watches.set(watchKey(chatId, threadId), watchState);
  await tailer.start();

  setupIdDriftDetection(botApi, watchState);
  setupCrossPostSubscription(botApi, watchState);

  // Wire relay client for replies
  const relayClient = await getRelayClient({
    sessionId: sessionInfo.id,
    sessionDir: sessionInfo.dir,
    claudePid: sessionInfo.pid,
  });
  if (relayClient) {
    bindRelayReplyHandler(
      botApi,
      relayClient,
      watchState,
      chatId,
      "auto-watch",
    );
  } else {
    getMessageBus()
      .send({
        chatId,
        threadId,
        content: `👁 Watching output only — no relay connection for ${sessionName}. Claude's responses will appear here but messages you send won't reach Claude until the relay reconnects.`,
        format: "auto",
      })
      .catch(() => {});
  }

  info("auto-watch: started", {
    chatId,
    threadId,
    sessionName,
    sessionId: sessionInfo.id,
    sessionDir: sessionInfo.dir,
  });
  return true;
}

/**
 * Start watching a session by name. Returns true on success.
 * Used by /watch command and auto-watch on /switch.
 */
export async function startWatchingSession(
  botApi: Api,
  chatId: number,
  threadId: number,
  targetName: string,
  reason = "watch",
): Promise<boolean> {
  // Stop existing watch if any
  if (watches.has(watchKey(chatId, threadId))) {
    stopWatching(chatId, threadId, botApi, "replace");
  }

  // Poll for session ID — freshly spawned sessions need a moment for the
  // relay port file to land in /tmp.
  let sessionInfo: ReturnType<typeof getSession> = null;
  const watchDeadline = Date.now() + 6_000;

  while (Date.now() < watchDeadline) {
    await forceRefresh();
    sessionInfo = getSession(targetName);
    if (sessionInfo?.id) break;
    await Bun.sleep(1_000);
  }

  if (!sessionInfo?.id) {
    error("watch: start failed, missing session id", {
      chatId,
      threadId,
      targetName,
    });
    return false;
  }

  // Final liveness check: session may have been killed while we awaited the
  // id. Skip watch creation so we don't leave an orphan whose sessionDir
  // mutes drift detection on sibling watches via the "sole owner" guard.
  if (!getSession(targetName)) {
    info("watch: session disappeared during setup, aborting", {
      chatId,
      threadId,
      targetName,
    });
    return false;
  }

  // Resolve JSONL path. May not exist yet — claude doesn't write the file
  // until the first prompt is submitted. The resolver polls briefly for the
  // real path (catches the case where CC writes under a different uuid than
  // the relay port file reported) and falls back to a guessed path that the
  // drift loop will re-resolve.
  // When a sibling session shares this dir (the common /spawn-second-session
  // case), gate off the newest-in-dir fallback so we don't seed this watch
  // with the sibling's live JSONL. Recovery to our own id, if it's still
  // mis-seeded, comes from _recoverMisboundTailer in the drift loop.
  const { excludeIds, hasSibling } = await inspectDirSiblings(
    sessionInfo.dir,
    sessionInfo.id,
  );
  const resolved = await _resolveLiveJsonlPath(sessionInfo, {
    excludeIds,
    allowNewestInDirFallback: !hasSibling,
  });
  const jsonlPath = resolved.path;

  // Spawn-initiated watches: the seeded sessionId is almost certainly
  // the watcher's stale-JSONL fallback for this dir. When the real id
  // shows up (after the first user prompt) we restart the tailer but
  // skip the "reconnected" broadcast — there's no prior conversation.
  const watchState: WatchState = buildWatchState({
    sessionName: targetName,
    sessionId: resolved.sessionId,
    sessionDir: sessionInfo.dir,
    sessionPid: sessionInfo.pid,
    chatId,
    threadId,
    suppressNextIdChangeNotice: reason === "spawn",
  });
  watchState.speculativeTailerPath = resolved.speculative;
  if (resolved.sessionId !== sessionInfo.id) {
    safeSync(
      "auto_watch.update_session_id",
      () => updateSessionId(targetName, resolved.sessionId),
      { severity: "debug" },
    );
  }
  const tailer = new SessionTailer(
    jsonlPath,
    makeWatchTailHandler(botApi, watchState),
  );
  watchState.tailer = tailer;
  watches.set(watchKey(chatId, threadId), watchState);
  await tailer.start();

  setupIdDriftDetection(botApi, watchState);
  setupCrossPostSubscription(botApi, watchState);

  // Wire relay client for replies. The JSONL tailer normally handles text
  // display, but if the tailer is stale (e.g. after /clear) the TCP path
  // is the only way the reply reaches us. The turn-claim protocol prevents
  // the tailer from duplicating text that TCP already delivered.
  const relayClient = await getRelayClient({
    sessionId: sessionInfo.id,
    sessionDir: sessionInfo.dir,
    claudePid: sessionInfo.pid,
  });
  if (relayClient) {
    bindRelayReplyHandler(botApi, relayClient, watchState, chatId, "watch");
  }

  const branch = await getGitBranch(sessionInfo.dir);
  updatePinnedStatus(botApi, chatId, {
    sessionName: null,
    isPlanMode: false,
    model: getCurrentModelDisplayName(),
    branch,
    isWatching: targetName,
  }).catch(() => {});

  info("watch: started", {
    chatId,
    threadId,
    sessionName: targetName,
    sessionId: sessionInfo.id,
    sessionDir: sessionInfo.dir,
    pid: sessionInfo.pid,
    reason,
  });
  return true;
}
