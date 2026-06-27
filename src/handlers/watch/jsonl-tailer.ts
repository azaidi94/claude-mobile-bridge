/**
 * JSONL tailer wiring: resolve a live JSONL path for a (possibly freshly-
 * spawned) session, poll for the session id to populate, then run a drift-
 * detection loop that rebinds the tailer if CC starts a new conversation
 * in the same directory or if the original tailer was pointed at a guessed
 * speculative path.
 */

import { stat } from "fs/promises";
import type { Api } from "grammy";
import { info } from "../../logger";
import { safeSync } from "../../utils/safe-async";
import { escapeHtml } from "../../formatting";
import { getMessageBus } from "../../messaging";
import { forceRefresh, getSession, updateSessionId } from "../../sessions";
import { scanPortFiles } from "../../relay";
import { forgetUsage } from "../../sessions/context-usage";
import {
  SessionTailer,
  findNewestSessionInDir,
  findSessionJsonlPath,
  getExpectedJsonlPath,
} from "../../sessions/tailer";
import { killedSessionIds, watchKey, watches } from "./registry";
import type { WatchState } from "./state";
import { makeWatchTailHandler } from "./tail-handler";

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
    /**
     * Ids the newest-in-dir probe must never adopt — sibling sessions' live
     * JSONLs sharing this directory.
     */
    excludeIds?: ReadonlySet<string>;
    /**
     * Whether to fall back to `findNewestSessionInDir` when the canonical id's
     * file never appears. Defaults to true (covers the CC-wrote-a-different-
     * uuid quirk for a solo session). MUST be false when a sibling session
     * shares the dir: there the "newest JSONL" is the sibling's (or a stale
     * pre-existing transcript), never the freshly-spawned target — adopting it
     * binds the watch to the wrong session. We stay speculative on the
     * canonical id and let the tailer pick up the real file when it lands.
     */
    allowNewestInDirFallback?: boolean;
  },
): Promise<{ path: string; sessionId: string; speculative: boolean }> {
  const directHit = await findSessionJsonlPath(sessionInfo.id);
  if (directHit) {
    return { path: directHit, sessionId: sessionInfo.id, speculative: false };
  }

  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const intervalMs = opts?.intervalMs ?? 1_000;
  const allowFallback = opts?.allowNewestInDirFallback ?? true;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await Bun.sleep(intervalMs);
    // Re-check the canonical id first (cheap), in case CC just wrote it.
    const direct = await findSessionJsonlPath(sessionInfo.id);
    if (direct) {
      return { path: direct, sessionId: sessionInfo.id, speculative: false };
    }
    // Then look for any JSONL the project dir gained — but never a sibling's.
    if (allowFallback) {
      const newestId = await findNewestSessionInDir(
        sessionInfo.dir,
        opts?.excludeIds,
      );
      if (newestId) {
        const newestPath = await findSessionJsonlPath(newestId);
        if (newestPath) {
          return { path: newestPath, sessionId: newestId, speculative: false };
        }
      }
    }
  }

  return {
    path: getExpectedJsonlPath(sessionInfo.dir, sessionInfo.id),
    sessionId: sessionInfo.id,
    speculative: true,
  };
}

/**
 * Inspect relay port files + active watches for OTHER sessions sharing
 * `sessionDir`. Returns their session ids (to exclude from the newest-in-dir
 * probe) and whether any sibling exists at all (used to gate the probe off —
 * see `allowNewestInDirFallback`). `ownId` is the target's canonical id and is
 * never treated as a sibling.
 */
export async function inspectDirSiblings(
  sessionDir: string,
  ownId: string,
): Promise<{ excludeIds: Set<string>; hasSibling: boolean }> {
  const excludeIds = new Set<string>();
  let hasSibling = false;

  try {
    const ports = await scanPortFiles();
    for (const pf of ports) {
      if (pf.cwd !== sessionDir) continue;
      if (pf.sessionId && pf.sessionId !== ownId) {
        excludeIds.add(pf.sessionId);
        hasSibling = true;
      }
    }
  } catch {
    // Best-effort — a failed scan just means no sibling exclusions this pass.
  }

  for (const w of watches.values()) {
    if (w.sessionDir !== sessionDir) continue;
    if (w.sessionId && w.sessionId !== ownId) {
      excludeIds.add(w.sessionId);
      hasSibling = true;
    }
  }

  // Recently-killed ids could still be the newest on disk for a moment.
  for (const id of killedSessionIds.keys()) excludeIds.add(id);

  return { excludeIds, hasSibling };
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
 * Read the live sessionId for a specific Claude PID from its relay port file.
 * This is the only signal that attributes a transcript to one of several
 * sessions sharing a directory: the relay runs as a child of the Claude process
 * (port file `ppid`) and keeps its `sessionId` current across /clear. Returns
 * undefined when the pid is unknown or no matching port file exists.
 */
async function liveSessionIdForPid(
  sessionDir: string,
  claudePid: number | undefined,
): Promise<string | undefined> {
  if (claudePid === undefined) return undefined;
  try {
    const ports = await scanPortFiles();
    const pf = ports.find(
      (p) => p.cwd === sessionDir && p.ppid === claudePid && p.sessionId,
    );
    return pf?.sessionId;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the conversation id this watch should currently be tailing — the
 * input to the drift loop's /clear follow.
 *
 * Sole owner of the dir: the newest JSONL by mtime is unambiguously this
 * session's (excluding recently-killed ids). Shared dir: mtime can't attribute
 * a transcript to a specific session, so trust the relay port file keyed by
 * this session's Claude PID (kept current across /clear by the relay's
 * discovery loop), falling back to the PID-pinned watcher cache id.
 *
 * Exported as a test seam.
 */
export async function _resolveDriftTargetId(
  watchState: WatchState,
): Promise<string | undefined> {
  let sharesDir = false;
  for (const other of watches.values()) {
    if (other === watchState) continue;
    if (other.sessionDir === watchState.sessionDir) {
      sharesDir = true;
      break;
    }
  }

  if (sharesDir) {
    // Attribute by this session's Claude PID via its relay port file — the only
    // signal that maps a transcript to one of several sessions in a shared dir.
    if (watchState.sessionPid !== undefined) {
      const byPid = await liveSessionIdForPid(
        watchState.sessionDir,
        watchState.sessionPid,
      );
      // No match (relay down, or port-file scan threw): KEEP the current id.
      // Falling back to a possibly-divergent cache id here would drag the
      // tailer back and re-fire "🔄 new conversation" on every transient miss
      // — the flapping the old sole-owner guard existed to prevent.
      return byPid ?? watchState.sessionId;
    }
    // No pid to attribute by: best-effort cache id (also PID-pinned via the
    // watcher's priorNameByPid), else keep current.
    return getSession(watchState.sessionName)?.id ?? watchState.sessionId;
  }

  const excludeIds =
    killedSessionIds.size > 0
      ? new Set<string>(killedSessionIds.keys())
      : undefined;
  const newestJsonl = await findNewestSessionInDir(
    watchState.sessionDir,
    excludeIds,
  );
  return newestJsonl ?? getSession(watchState.sessionName)?.id ?? undefined;
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
    // Recover a mis-seeded watch that adopted a *sibling's* JSONL (its own
    // file didn't exist yet at spawn). This runs BEFORE the sole-owner guard
    // below — without it, a sibling sharing the dir would mute recovery
    // forever and the watch would stream the wrong session indefinitely.
    if (await _recoverMisboundTailer(botApi, watchState)) return;
    // Where does this watch's conversation currently live? Sole owner: newest
    // JSONL by mtime. Shared dir: the relay port file keyed by this session's
    // Claude PID (mtime can't attribute a transcript when a sibling shares the
    // dir). This restores shared-dir /clear follow that 3c97a8d's blanket
    // sole-owner guard disabled — attribution is now by PID, not "newest file".
    const newId = await _resolveDriftTargetId(watchState);

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
    const previousSpeculative = watchState.speculativeTailerPath === true;
    watchState.sessionId = newId;
    const newPath = await findSessionJsonlPath(newId);
    if (!newPath) {
      watchState.sessionId = previousId;
      return;
    }
    if (await _isBackwardDriftTarget(newPath, previousId)) {
      watchState.sessionId = previousId;
      return;
    }
    watchState.tailer?.stop();
    forgetUsage(previousId);
    const newTailer = new SessionTailer(
      newPath,
      makeWatchTailHandler(botApi, watchState),
    );
    // Tail the new JSONL from EOF. We deliberately do NOT read from offset 0
    // here: `findNewestSessionInDir` picks by mtime, so a resumed conversation
    // (claude --resume, --continue, picker reopen) appears as "newest" and
    // its JSONL is already huge — offset-0 would dump the entire historical
    // transcript into TG. LIVE-only: the cost is missing the first user
    // prompt on a fresh /clear (lands on disk before the 5s drift tick).
    watchState.tailer = newTailer;
    // Clear the speculative flag and, if the interval was running at the
    // aggressive 1s cadence because of it, restart it at the normal 5s cadence.
    // Without this, the next speculative-branch tick (~284) sees the stale flag
    // and performs a redundant rebind that stops the fresh tailer at EOF.
    watchState.speculativeTailerPath = false;
    if (previousSpeculative && watchState.idCheckInterval) {
      clearInterval(watchState.idCheckInterval);
      setupIdDriftDetection(botApi, watchState);
    }
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
 * True when a drift target's JSONL was last modified BEFORE the one currently
 * tailed — i.e. the "roll" would move the watch backward onto a staler
 * transcript. A genuine /clear or resume target is always at least as fresh as
 * what we're tailing, so a backward target can only come from a bogus external
 * signal — e.g. an old relay (pre-fix; the relay doesn't hot-reload) whose
 * discovery loop oscillates the port file's sessionId between two stale
 * transcripts every 15s. Following each flip would bounce the tailer — and
 * post "🔄 new conversation" to the topic — forever. False whenever either
 * side can't be statted (speculative path, file gone): only a *proven*
 * backward roll is skipped. Exported as a test seam.
 */
export async function _isBackwardDriftTarget(
  newPath: string,
  previousId: string,
): Promise<boolean> {
  const previousPath = await findSessionJsonlPath(previousId);
  if (!previousPath) return false;
  const [newStat, prevStat] = await Promise.all([
    stat(newPath).catch(() => null),
    stat(previousPath).catch(() => null),
  ]);
  return !!newStat && !!prevStat && newStat.mtimeMs < prevStat.mtimeMs;
}

/**
 * True when this watch is currently tailing a JSONL that belongs to a *sibling*
 * session sharing the same dir — i.e. the watch was mis-seeded onto another
 * session's transcript. Distinguished from a legitimate /clear drift, where
 * `watchState.sessionId` is this session's own fresh-conversation id that no
 * sibling port file or watch owns.
 */
async function _isBoundToSiblingJsonl(
  watchState: WatchState,
): Promise<boolean> {
  for (const other of watches.values()) {
    if (other === watchState) continue;
    if (
      other.sessionDir === watchState.sessionDir &&
      other.sessionId === watchState.sessionId
    ) {
      return true;
    }
  }
  try {
    const ports = await scanPortFiles();
    return ports.some(
      (pf) =>
        pf.cwd === watchState.sessionDir &&
        pf.sessionId === watchState.sessionId &&
        pf.sessionName !== undefined &&
        pf.sessionName !== watchState.sessionName,
    );
  } catch {
    return false;
  }
}

// Watches with an in-flight recovery. The drift interval callback is async, so
// setInterval can fire a second tick before the first's awaits resolve. Without
// this guard two overlapping ticks could both reach rebindTailerPath — and the
// second's `tailer.stop()` can race the first's `watchState.tailer = …`
// assignment, leaking a still-running tailer that duplicates every event into
// the topic. (The existing newest-in-dir drift path avoids this by claiming the
// id synchronously before its awaits; recovery needs the awaits up front, so it
// guards with this flag instead.)
const recoveryInFlight = new WeakSet<WatchState>();

/**
 * Rebind a mis-seeded watch from a sibling's JSONL onto its OWN canonical id's
 * file once that file exists on disk. The registry/port-file id for our session
 * name is authoritative (a freshly-spawned session's port file is never stale,
 * unlike the /clear case), so we trust it over whatever sibling file the path
 * resolver fell back to at startup.
 *
 * No-ops (returns false) unless: the canonical id differs from what we're
 * tailing, that id isn't blacklisted, no recovery is already running for this
 * watch, we're demonstrably bound to a sibling's file, no other live watch
 * *legitimately* holds the canonical id, and the canonical file is on disk.
 * Exported as a test seam.
 */
export async function _recoverMisboundTailer(
  botApi: Api,
  watchState: WatchState,
): Promise<boolean> {
  const canonicalId = getSession(watchState.sessionName)?.id;
  if (!canonicalId) return false;
  if (canonicalId === watchState.sessionId) return false;
  if (killedSessionIds.has(canonicalId)) return false;
  if (recoveryInFlight.has(watchState)) return false;

  recoveryInFlight.add(watchState);
  try {
    if (!(await _isBoundToSiblingJsonl(watchState))) return false;

    // Don't steal the canonical id from a sibling watch that *legitimately*
    // holds it (the id is that watch's own canonical). A sibling that is merely
    // mis-bound onto our id must NOT block us — otherwise a mutual swap (each
    // watch holding the other's id) would deadlock, with neither able to
    // recover because each sees the other "holding" its target id.
    for (const other of watches.values()) {
      if (other === watchState) continue;
      if (other.sessionId !== canonicalId) continue;
      if (getSession(other.sessionName)?.id === canonicalId) return false;
    }

    const canonicalPath = await findSessionJsonlPath(canonicalId);
    if (!canonicalPath) return false;

    const previousId = watchState.sessionId;
    const wasSpawnSeed = watchState.suppressNextIdChangeNotice === true;
    watchState.suppressNextIdChangeNotice = false;
    await rebindTailerPath(botApi, watchState, canonicalPath, canonicalId);
    info("watch: recovered mis-bound tailer to canonical id", {
      chatId: watchState.chatId,
      threadId: watchState.threadId,
      sessionName: watchState.sessionName,
      previousId,
      canonicalId,
      wasSpawnSeed,
    });
    return true;
  } finally {
    recoveryInFlight.delete(watchState);
  }
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
    safeSync(
      "watch.update_session_id",
      () => updateSessionId(watchState.sessionName, newId),
      { severity: "debug" },
    );
  }
  const newTailer = new SessionTailer(
    newPath,
    makeWatchTailHandler(botApi, watchState),
  );
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
