/**
 * Persistent registry for ralph loops at <STATE_DIR>/ralph.json.
 *
 * Cloned from src/cron/store.ts (debounced atomic JSON writes, env-var path
 * seam, test reset). One loop runs at a time — `addLoop` rejects when an active
 * loop already exists and prunes the previous non-active record (and its
 * runDir) on success.
 *
 * A synchronous cached accessor (`getActiveLoopSync`) backs the hot text-handler
 * guard (invariant 2): every message in the ralph topic checks it, so it must
 * not await disk. The cache is hydrated at boot via `getLoops()` and kept
 * coherent on every mutation.
 */

import { readFile, writeFile, mkdir, rename, rm } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { STATE_DIR } from "../paths";
import { info, warn } from "../logger";

export interface RalphLoop {
  id: string; // Date.now().toString(36) style
  repoPath: string; // canonical (realpath) absolute path
  iterations: number;
  prMode: boolean;
  label?: string;
  state: "starting" | "running" | "completed" | "stopped" | "ended";
  pid?: number; // wrapper pid, from meta.json
  topicId?: number;
  chatId?: number;
  runDir: string; // <STATE_DIR>/ralph/<id>
  tailOffset: number; // resume point into run.log
  lastIteration?: { n: number; total: number };
  verbose: boolean;
  startedAt: string; // ISO
  endedAt?: string;
  endReason?: string; // "complete" | "max-iterations" | "no-issues" | "stopped" | "exit:<code>" | "process-died"
}

interface RalphStore {
  loops: RalphLoop[];
}

const ACTIVE_STATES: ReadonlySet<RalphLoop["state"]> = new Set([
  "starting",
  "running",
]);

function storePath(): string {
  return process.env.RALPH_STORE_PATH || join(STATE_DIR, "ralph.json");
}

let cache: RalphStore = { loops: [] };
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// Synchronous mirror of the current active loop, for the text-handler guard.
// Recomputed on every mutation and on load.
let activeLoopCache: RalphLoop | null = null;

function recomputeActive(): void {
  activeLoopCache = cache.loops.find((l) => ACTIVE_STATES.has(l.state)) ?? null;
}

async function ensureDir(): Promise<void> {
  const dir = dirname(storePath());
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

async function load(): Promise<void> {
  if (loaded) return;
  try {
    if (existsSync(storePath())) {
      const raw = await readFile(storePath(), "utf-8");
      const parsed = JSON.parse(raw) as RalphStore;
      if (parsed && Array.isArray(parsed.loops)) cache = parsed;
    }
  } catch (err) {
    warn(`ralph-store: load failed, starting empty: ${err}`);
    cache = { loops: [] };
  }
  loaded = true;
  recomputeActive();
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    persist().catch((err) => warn(`ralph-store: persist failed`, err));
  }, 250);
}

async function persist(): Promise<void> {
  await ensureDir();
  const tmp = `${storePath()}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2));
  await rename(tmp, storePath());
}

/** Cancel pending debounced save and persist immediately. */
export async function flush(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await persist();
}

export async function getLoops(): Promise<RalphLoop[]> {
  await load();
  return [...cache.loops];
}

/** Active = state starting|running. At most one exists (enforced by addLoop). */
export async function getActiveLoop(): Promise<RalphLoop | null> {
  await load();
  return activeLoopCache;
}

/**
 * Synchronous cached accessor for the text-handler guard (invariant 2). Returns
 * null until the store is hydrated (call `getLoops()`/`getActiveLoop()` once at
 * boot). Never awaits — safe on the message hot path.
 */
export function getActiveLoopSync(): RalphLoop | null {
  return activeLoopCache;
}

/**
 * Synchronous check for the output-only loop-topic guard (invariant 2). Both
 * ids must match — topic ids are per-chat sequence numbers and collide across
 * chats, so threadId alone would swallow unrelated topics in other chats.
 */
export function isRalphLoopTopic(chatId?: number, threadId?: number): boolean {
  const rl = activeLoopCache;
  return (
    rl?.topicId !== undefined && rl.chatId === chatId && rl.topicId === threadId
  );
}

/**
 * Add a new loop record. Rejects (returns an error string) when an active loop
 * already exists. On success, prunes any previous non-active record and rm -rf
 * its runDir so old run logs never accumulate.
 */
export async function addLoop(
  loop: Omit<RalphLoop, "state"> & { state?: RalphLoop["state"] },
): Promise<{ ok: true; loop: RalphLoop } | { ok: false; error: string }> {
  await load();
  if (activeLoopCache) {
    return {
      ok: false,
      error: `active loop already running on ${activeLoopCache.repoPath}`,
    };
  }

  // Check → splice → push stays synchronous: an await between the active-check
  // and the push would let a concurrent addLoop (commands bypass sequentialize)
  // pass the same check and create two active loops. Run dirs are removed after.
  const stale = cache.loops.splice(0, cache.loops.length);
  const created: RalphLoop = { ...loop, state: loop.state ?? "starting" };
  cache.loops.push(created);
  recomputeActive();
  scheduleSave();
  info(`ralph-store: added loop ${created.id} (${created.repoPath})`);

  // Prune previous (non-active) records' run dirs.
  for (const old of stale) {
    if (old.runDir) {
      await rm(old.runDir, { recursive: true, force: true }).catch((err) =>
        warn(`ralph-store: failed to rm old runDir ${old.runDir}: ${err}`),
      );
    }
    info(`ralph-store: pruned old loop ${old.id} (${old.state})`);
  }

  return { ok: true, loop: created };
}

export async function updateLoop(
  id: string,
  patch: Partial<RalphLoop>,
): Promise<RalphLoop | null> {
  await load();
  const loop = cache.loops.find((l) => l.id === id);
  if (!loop) return null;
  Object.assign(loop, patch);
  recomputeActive();
  scheduleSave();
  return loop;
}

export async function removeLoop(id: string): Promise<boolean> {
  await load();
  const before = cache.loops.length;
  cache.loops = cache.loops.filter((l) => l.id !== id);
  if (cache.loops.length !== before) {
    recomputeActive();
    scheduleSave();
    return true;
  }
  return false;
}

/** Test seam: reset cache + cancel pending save. */
export function _resetRalphStoreForTesting(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  cache = { loops: [] };
  loaded = false;
  activeLoopCache = null;
}
