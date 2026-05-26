/**
 * JSONL tailer wiring: resolve a live JSONL path for a (possibly freshly-
 * spawned) session, poll for the session id to populate, then run a drift-
 * detection loop that rebinds the tailer if CC starts a new conversation
 * in the same directory or if the original tailer was pointed at a guessed
 * speculative path.
 */

import type { Api } from "grammy";
import { info } from "../../logger";
import { escapeHtml } from "../../formatting";
import { getMessageBus } from "../../messaging";
import { forceRefresh, getSession, updateSessionId } from "../../sessions";
import { forgetUsage } from "../../sessions/context-usage";
import {
  SessionTailer,
  findNewestSessionInDir,
  findSessionJsonlPath,
  getExpectedJsonlPath,
  type TailEvent,
} from "../../sessions/tailer";
import { globalEventBus } from "../../web/sse";
import { maybeNotifyContextCrossing } from "./context-usage";
import { bridgeTailToSse, handleTailEvent } from "./event-router";
import { killedSessionIds, watchKey, watches } from "./registry";
import type { WatchState } from "./state";

/**
 * Resolve a live JSONL path for a session that may not have written its file
 * yet. Tries the registry id first; if missing, polls `findNewestSessionInDir`
 * briefly to catch the case where CC writes its real JSONL under a different
 * uuid than the relay port file reported. Falls back to the expected (guessed)
 * path and returns speculative=true so the drift loop can rescue it later.
 *
 * Exported as a test seam.
 */
export async function _resolveLiveJsonlPath(
  sessionInfo: import("../../sessions/types").SessionInfo,
  opts?: {
    /** Total polling budget in ms (default ~10s). */
    timeoutMs?: number;
    /** Per-attempt sleep (default 1s). */
    intervalMs?: number;
  },
): Promise<{ path: string; sessionId: string; speculative: boolean }> {
  const directHit = await findSessionJsonlPath(sessionInfo.id);
  if (directHit) {
    return { path: directHit, sessionId: sessionInfo.id, speculative: false };
  }

  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const intervalMs = opts?.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await Bun.sleep(intervalMs);
    // Re-check the canonical id first (cheap), in case CC just wrote it.
    const direct = await findSessionJsonlPath(sessionInfo.id);
    if (direct) {
      return { path: direct, sessionId: sessionInfo.id, speculative: false };
    }
    // Then look for any JSONL the project dir gained.
    const newestId = await findNewestSessionInDir(sessionInfo.dir);
    if (newestId) {
      const newestPath = await findSessionJsonlPath(newestId);
      if (newestPath) {
        return { path: newestPath, sessionId: newestId, speculative: false };
      }
    }
  }

  return {
    path: getExpectedJsonlPath(sessionInfo.dir, sessionInfo.id),
    sessionId: sessionInfo.id,
    speculative: true,
  };
}

// Backoff schedule for awaiting a fresh session's first JSONL write.
// Total wait: ~37s. Brand-new Claude sessions usually populate within 1–3s.
const AUTO_WATCH_RETRY_DELAYS_MS = [2000, 5000, 10000, 20000];

/**
 * Wait for a session's id to populate via the watcher cache.
 *
 * Brand-new Claude Code sessions appear in the relay port file before their
 * JSONL file has its first parseable line, so the initial scan can return
 * SessionInfo with id="". We poll forceRefresh()/getSession() with backoff
 * until the id resolves, the session disappears, or retries are exhausted.
 */
export async function _awaitSessionId(
  sessionName: string,
  delaysMs: number[] = AUTO_WATCH_RETRY_DELAYS_MS,
): Promise<import("../../sessions/types").SessionInfo | null> {
  for (const delay of [0, ...delaysMs]) {
    if (delay) await Bun.sleep(delay);
    await forceRefresh();
    const info = getSession(sessionName);
    if (!info) return null;
    if (info.id) return info;
  }
  return null;
}

/**
 * Poll for new-conversation detection: when the desktop session starts a new
 * conversation (new JSONL, same dir), restart the tailer against the new file.
 * /clear doesn't rewrite the relay port file, so without this the tailer stays
 * stuck on the stale pre-/clear JSONL while relay messages still flow.
 */
export function setupIdDriftDetection(
  botApi: Api,
  watchState: WatchState,
): void {
  const { chatId, threadId, sessionName } = watchState;
  // Speculative watches poll more aggressively so a misbehaving CC version
  // that wrote its real JSONL under a different uuid than the port file
  // reported gets adopted within a second or two instead of being stuck.
  const intervalMs = watchState.speculativeTailerPath ? 1_000 : 5_000;
  watchState.idCheckInterval = setInterval(async () => {
    if (!watches.has(watchKey(chatId, threadId))) return;
    // Only drift when sole owner of the dir. With siblings, the newest
    // JSONL can't be attributed to a specific named session, and toggling
    // sessionId on each mode change would fire spurious "🔄" notices and
    // revert /clear recovery earned while solo.
    for (const other of watches.values()) {
      if (other === watchState) continue;
      if (other.sessionDir === watchState.sessionDir) return;
    }
    const excludeIds =
      killedSessionIds.size > 0
        ? new Set<string>(killedSessionIds.keys())
        : undefined;
    const newestJsonl = await findNewestSessionInDir(
      watchState.sessionDir,
      excludeIds,
    );
    const newId = newestJsonl ?? getSession(sessionName)?.id;

    if (!newId) return;
    if (killedSessionIds.has(newId)) return;

    // Speculative-watch fallback: even if `newId === sessionId`, our current
    // tailer may be pointed at a guessed path that doesn't exist on disk
    // (CC chose a different uuid than the relay port file's id). In that
    // case, if `findNewestSessionInDir` returns *anything* and the
    // speculative path isn't on disk, re-resolve via the newest id.
    if (newId === watchState.sessionId) {
      if (!watchState.speculativeTailerPath) return;
      const currentPathExists = await findSessionJsonlPath(
        watchState.sessionId,
      ).then((p) => p !== null);
      if (currentPathExists) {
        // Real JSONL appeared under the original id — bind to it and clear
        // the speculative flag so the loop reverts to the slow interval.
        const realPath = await findSessionJsonlPath(watchState.sessionId);
        if (realPath) {
          await rebindTailerPath(botApi, watchState, realPath, newId);
        }
        return;
      }
      // Same id still un-flushed; nothing else to do this tick.
      return;
    }
    // Defense in depth: don't steal an id another live watcher already holds.
    for (const other of watches.values()) {
      if (other === watchState) continue;
      if (other.sessionDir !== watchState.sessionDir) continue;
      if (other.sessionId === newId) return;
    }
    // Claim synchronously so a concurrent drift tick on a sibling watch sees
    // this id as taken before its own guard runs.
    const previousId = watchState.sessionId;
    watchState.sessionId = newId;
    const newPath = await findSessionJsonlPath(newId);
    if (!newPath) {
      watchState.sessionId = previousId;
      return;
    }
    watchState.tailer?.stop();
    forgetUsage(previousId);
    const newTailer = new SessionTailer(newPath, (event: TailEvent) => {
      if (event.type === "usage" && event.usage) {
        void maybeNotifyContextCrossing(botApi, watchState, event.usage);
      }
      handleTailEvent(botApi, watchState, event, watchState.threadId);
      bridgeTailToSse(globalEventBus, watchState.sessionName, event);
    });
    // Tail the new JSONL from EOF. We deliberately do NOT read from offset 0
    // here: `findNewestSessionInDir` picks by mtime, so a resumed conversation
    // (claude --resume, --continue, picker reopen) appears as "newest" and
    // its JSONL is already huge — offset-0 would dump the entire historical
    // transcript into TG. LIVE-only: the cost is missing the first user
    // prompt on a fresh /clear (lands on disk before the 5s drift tick).
    watchState.tailer = newTailer;
    await newTailer.start();
    const wasSpawnSeed = watchState.suppressNextIdChangeNotice === true;
    watchState.suppressNextIdChangeNotice = false;
    info("watch: restarted tailer for new conversation", {
      chatId,
      sessionName,
      sessionId: newId,
      suppressedNotice: wasSpawnSeed,
    });
    if (wasSpawnSeed) return;
    getMessageBus()
      .send({
        chatId,
        threadId: watchState.threadId,
        content: `🔄 <b>${escapeHtml(sessionName)}</b> started a new conversation.`,
        format: "html",
      })
      .catch(() => {});
  }, intervalMs);
}

/**
 * Restart the tailer against a different on-disk JSONL. Used both by the
 * normal drift path (id changed) and by the speculative recovery path (id
 * stayed the same but original tailer was pointed at a guessed path).
 * Clears `speculativeTailerPath` once the new tailer is bound to a real file.
 */
export async function rebindTailerPath(
  botApi: Api,
  watchState: WatchState,
  newPath: string,
  newId: string,
): Promise<void> {
  const previousId = watchState.sessionId;
  const previousSpeculative = watchState.speculativeTailerPath === true;
  watchState.tailer?.stop();
  if (previousId !== newId) {
    forgetUsage(previousId);
    watchState.sessionId = newId;
    // Optional belt: keep the watcher registry in sync if the new id isn't
    // already tracked under some other name. updateSessionId is a no-op if
    // the session isn't in cache, so it's safe.
    try {
      updateSessionId(watchState.sessionName, newId);
    } catch {}
  }
  const newTailer = new SessionTailer(newPath, (event: TailEvent) => {
    if (event.type === "usage" && event.usage) {
      void maybeNotifyContextCrossing(botApi, watchState, event.usage);
    }
    handleTailEvent(botApi, watchState, event, watchState.threadId);
    bridgeTailToSse(globalEventBus, watchState.sessionName, event);
  });
  watchState.tailer = newTailer;
  watchState.speculativeTailerPath = false;
  await newTailer.start();
  // If the loop interval was tuned to "speculative" (1s) but we've now bound
  // a real path, restart the interval at the slower cadence.
  if (previousSpeculative && watchState.idCheckInterval) {
    clearInterval(watchState.idCheckInterval);
    setupIdDriftDetection(botApi, watchState);
  }
  info("watch: rebound tailer to live JSONL", {
    chatId: watchState.chatId,
    threadId: watchState.threadId,
    sessionName: watchState.sessionName,
    previousId,
    newId,
    newPath,
    wasSpeculative: previousSpeculative,
  });
}
