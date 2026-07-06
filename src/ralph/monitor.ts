/**
 * Ralph loop monitor: the bot-side half of a running loop.
 *
 * The desktop terminal runs ralph-runner.sh, which mirrors the loop's stdout to
 * <runDir>/run.log and writes <runDir>/exit on completion. This module tails
 * run.log by byte offset, parses beat markers (events.ts), posts distilled
 * beats to the loop's topic, optionally attaches a verbose transcript watch per
 * iteration, tree-kills on /ralph stop, and finalizes exactly once.
 *
 * Single active loop → module-level singleton state. IO is kept thin; the
 * testable logic lives in pure helpers (parser in events.ts, `collectTree`
 * here).
 */

import type { Api } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { join } from "path";
import { open, stat, readFile } from "fs/promises";
import { realpathSync } from "fs";
import { info, warn } from "../logger";
import { getMessageBus } from "../messaging";
import {
  suppressDirNotifications,
  forceRefresh,
  getSessions,
} from "../sessions";
import { escapeHtml } from "../formatting";
import { RalphLogParser, type RalphEvent } from "./events";
import { collectTree } from "./tree";
import {
  getActiveLoop,
  getActiveLoopSync,
  updateLoop,
  flush,
  type RalphLoop,
} from "./store";

// Suppression window re-armed on every iteration (invariant 3): ephemeral
// per-iteration claudes must never trigger 🟢/🔴 broadcasts or auto-topics.
const SUPPRESS_ITER_MS = 600_000; // 10 min
const SUPPRESS_FINAL_MS = 90_000;
const TICK_MS = 1_500;
const VERBOSE_ATTACH_DEADLINE_MS = 90_000;
const GH_TIMEOUT_MS = 5_000;

// ---- singleton monitor state ------------------------------------------------

let intervalTimer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let parser = new RalphLogParser();
// Finalize guard keyed by loop id, not a bare boolean: a stale flag from a
// previous loop must not swallow finalize for the next one (e.g. /ralph stop
// during loop 2's "starting" window, before startRalphMonitor runs).
let finalizedLoopId: string | null = null;
// Set by stopRalphLoop before the kill so an in-flight tick (the interval is
// cleared, but a tick suspended in an await keeps running) can't observe the
// dying pid first and finalize as "process-died", stealing the "stopped"
// reason.
let stopPending = false;
// Generation token for the verbose-watch attach poll. Bumped whenever a new
// attach starts or verbose is toggled off / the loop finalizes, so a stale
// 90s poll from a previous iteration aborts instead of attaching late.
let attachGen = 0;

// ---- helpers ----------------------------------------------------------------

// Watch functions are loaded lazily (runtime dynamic import) rather than
// statically: ralph.ts lives in the commands module graph, and a static
// monitor → handlers/watch edge introduces an import-order cycle
// (commands → ralph → monitor → watch, while commands → spawn → watch is
// mid-evaluation). Deferring to call time sidesteps it entirely.
type WatchMod = typeof import("../handlers/watch");
let _watchMod: WatchMod | null = null;
async function watch(): Promise<WatchMod> {
  if (!_watchMod) _watchMod = await import("../handlers/watch");
  return _watchMod;
}

async function defaultPgrep(pid: number): Promise<number[]> {
  try {
    const proc = Bun.spawn(["pgrep", "-P", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out
      .split("\n")
      .map((l) => parseInt(l.trim(), 10))
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not ours to signal (still alive); ESRCH = gone.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function tryRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p.replace(/\/+$/, "") || p;
  }
}

/** Read run.log from a byte offset to EOF. Returns "" when the file is absent. */
async function readFromOffset(
  path: string,
  offset: number,
): Promise<{ text: string; bytesRead: number }> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return { text: "", bytesRead: 0 }; // not created yet
  }
  if (size <= offset) return { text: "", bytesRead: 0 };
  const len = size - offset;
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, offset);
    return { text: buf.toString("utf-8", 0, bytesRead), bytesRead };
  } finally {
    await fh.close();
  }
}

async function readExitFile(path: string): Promise<number | null> {
  try {
    const raw = (await readFile(path, "utf-8")).trim();
    const code = parseInt(raw, 10);
    return Number.isFinite(code) ? code : null;
  } catch {
    return null;
  }
}

interface IssueSummary {
  count: number;
  next?: { number: number; title: string };
}

/** Best-effort open-issue snapshot for beat enrichment. Silent on any failure. */
async function ghIssueSummary(loop: RalphLoop): Promise<IssueSummary | null> {
  try {
    const args = ["issue", "list", "--state", "open", "--json", "number,title"];
    if (loop.label) args.push("--label", loop.label);
    const proc = Bun.spawn(["gh", ...args], {
      cwd: loop.repoPath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill(), GH_TIMEOUT_MS);
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    if (proc.exitCode !== 0) return null;
    const arr = JSON.parse(out) as { number: number; title: string }[];
    if (!Array.isArray(arr)) return null;
    const sorted = [...arr].sort((a, b) => a.number - b.number);
    return { count: arr.length, next: sorted[0] };
  } catch {
    return null;
  }
}

function post(
  api: Api,
  loop: RalphLoop,
  content: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<unknown> {
  if (loop.chatId === undefined) return Promise.resolve();
  return getMessageBus()
    .send({
      chatId: loop.chatId,
      threadId: loop.topicId,
      content,
      format: "html",
      replyMarkup,
    })
    .catch((err) => warn(`ralph: post failed: ${err}`));
}

// Terminal reasons where the loop finished its work (vs. stopped/crashed) —
// the topic has served its purpose, so offer a one-tap delete.
function isNaturalCompletion(reason: string): boolean {
  return (
    reason === "complete" ||
    reason === "no-issues" ||
    reason === "max-iterations"
  );
}

/** Inline "delete topic" button; callback handled in handlers/callback.ts. */
function deleteTopicKeyboard(loop: RalphLoop): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "🗑 Delete topic", callback_data: `ralph:deltopic:${loop.id}` }],
    ],
  };
}

// ---- verbose transcript watch ----------------------------------------------

/** Snapshot in-dir session ids/pids, then poll for a NEW session to attach. */
async function attachVerboseWatch(api: Api, loop: RalphLoop): Promise<void> {
  const { chatId, topicId } = loop;
  if (chatId === undefined || topicId === undefined) return;
  const gen = ++attachGen;
  const w = await watch();
  w.stopWatching(chatId, topicId, api, "ralph-iter");

  const cache = new Map<string, string>();
  const canon = (p: string): string => {
    const hit = cache.get(p);
    if (hit !== undefined) return hit;
    const r = tryRealpath(p);
    cache.set(p, r);
    return r;
  };
  const repo = canon(loop.repoPath);
  const seenIds = new Set<string>();
  const seenPids = new Set<number>();
  for (const s of getSessions()) {
    if (canon(s.dir) !== repo) continue;
    if (s.id) seenIds.add(s.id);
    if (s.pid !== undefined) seenPids.add(s.pid);
  }

  const deadline = Date.now() + VERBOSE_ATTACH_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (gen !== attachGen) return; // superseded (newer iteration / verbose off)
    await forceRefresh();
    const fresh = getSessions().filter(
      (s) =>
        canon(s.dir) === repo &&
        ((s.id && !seenIds.has(s.id)) ||
          (s.pid !== undefined && !seenPids.has(s.pid))),
    );
    if (fresh.length && gen === attachGen) {
      const target = fresh[fresh.length - 1]!;
      await w
        .startAutoWatch(api, chatId, topicId, target.name)
        .catch((err) => warn(`ralph: verbose attach failed: ${err}`));
      // Superseded while startAutoWatch was in flight (finalize/verbose off
      // bumped the gen after its stopWatching ran) — tear down the watch we
      // just registered or it leaks past the loop's end.
      if (gen !== attachGen) {
        w.stopWatching(chatId, topicId, api, "ralph-stale-attach");
      }
      return;
    }
    await Bun.sleep(2_000);
  }
  info("ralph: verbose watch — no new session appeared this iteration");
}

/** Verbose toggled on mid-loop: attach to the newest existing in-dir session. */
async function attachNewestNow(api: Api, loop: RalphLoop): Promise<void> {
  const { chatId, topicId } = loop;
  if (chatId === undefined || topicId === undefined) return;
  const gen = ++attachGen; // cancel any in-flight per-iteration poll
  const w = await watch();
  w.stopWatching(chatId, topicId, api, "ralph-verbose-on");
  await forceRefresh();
  if (gen !== attachGen) return; // superseded while refreshing
  const repo = tryRealpath(loop.repoPath);
  const inDir = getSessions().filter((s) => tryRealpath(s.dir) === repo);
  if (!inDir.length) return; // nothing running yet — next iteration will attach
  const target = inDir[inDir.length - 1]!;
  await w
    .startAutoWatch(api, chatId, topicId, target.name)
    .catch((err) => warn(`ralph: verbose attach-now failed: ${err}`));
  if (gen !== attachGen) {
    w.stopWatching(chatId, topicId, api, "ralph-stale-attach");
  }
}

// ---- event handling ---------------------------------------------------------

function stateFor(reason: string): RalphLoop["state"] {
  if (reason === "complete" || reason === "no-issues") return "completed";
  if (reason === "stopped") return "stopped";
  return "ended";
}

async function handleEvent(
  api: Api,
  loop: RalphLoop,
  ev: RalphEvent,
): Promise<void> {
  // Re-arm suppression on EVERY parsed event (invariant 3) so the ephemeral
  // claude never broadcasts online/offline or spawns an auto-topic even when
  // iteration markers are sparse (custom RALPH_SCRIPT, long watchdog waits).
  // Terminal events re-arm the shorter final window in finalize() right after.
  suppressDirNotifications(loop.repoPath, SUPPRESS_ITER_MS);
  switch (ev.type) {
    case "iteration": {
      loop.lastIteration = { n: ev.n, total: ev.total };
      await updateLoop(loop.id, { lastIteration: loop.lastIteration });
      const summary = await ghIssueSummary(loop);
      let content = `🔄 iter ${ev.n}/${ev.total}`;
      if (summary) {
        content += ` · ${summary.count} issue${summary.count === 1 ? "" : "s"} open`;
        if (summary.next) {
          content += ` · next: #${summary.next.number} ${escapeHtml(
            summary.next.title,
          )}`;
        }
      }
      await post(api, loop, content);
      if (loop.verbose) void attachVerboseWatch(api, loop);
      return;
    }
    case "waiting":
      await post(api, loop, "⏸ WAITING — blocked tasks, loop will retry");
      return;
    case "timeout":
      await post(
        api,
        loop,
        `⏱ iteration timed out after ${ev.seconds}s — session killed, continuing`,
      );
      return;
    case "no-issues":
      await finalize(
        api,
        loop,
        "no-issues",
        "🏁 no open issues — nothing to do",
      );
      return;
    case "complete":
      await finalize(
        api,
        loop,
        "complete",
        `🏁 COMPLETE after ${ev.iterations} iteration${ev.iterations === 1 ? "" : "s"}`,
      );
      return;
    case "max-iterations":
      await finalize(
        api,
        loop,
        "max-iterations",
        `⚠️ reached max iterations (${ev.n}) — issues may remain open`,
      );
      return;
  }
}

/** Single idempotent teardown path. First caller wins. */
async function finalize(
  api: Api,
  loop: RalphLoop,
  reason: string,
  finalBeat: string,
): Promise<void> {
  if (finalizedLoopId === loop.id) return;
  finalizedLoopId = loop.id;
  stopRalphMonitor();
  ++attachGen; // cancel any verbose poll
  if (loop.chatId !== undefined && loop.topicId !== undefined) {
    (await watch()).stopWatching(loop.chatId, loop.topicId, api, "ralph-final");
  }
  const state = stateFor(reason);
  loop.state = state;
  loop.endReason = reason;
  await updateLoop(loop.id, {
    state,
    endedAt: new Date().toISOString(),
    endReason: reason,
  });
  // Suppress once more so the winding-down claude's port-file reaping doesn't
  // fire a stray 🔴 broadcast after the loop ends.
  suppressDirNotifications(loop.repoPath, SUPPRESS_FINAL_MS);
  // Offer a delete-topic button once the loop finished on its own — but only
  // when we have a real forum topic (fallback-to-invoking-chat loops have no
  // topicId, so there's nothing to delete). Attach it to the LAST message.
  const delMarkup =
    loop.topicId !== undefined && isNaturalCompletion(reason)
      ? deleteTopicKeyboard(loop)
      : undefined;
  const summary = await ghIssueSummary(loop);
  await post(api, loop, finalBeat, summary ? undefined : delMarkup);
  if (summary) {
    await post(
      api,
      loop,
      `📊 ${summary.count} open issue${summary.count === 1 ? "" : "s"} remaining`,
      delMarkup,
    );
  }
  await flush();
  info(`ralph: finalized loop ${loop.id} (${reason})`);
}

// ---- tick loop --------------------------------------------------------------

async function tick(api: Api, loop: RalphLoop): Promise<void> {
  if (finalizedLoopId === loop.id || stopPending) return;
  const logPath = join(loop.runDir, "run.log");

  // 1. Drain new bytes → events.
  const chunk = await readFromOffset(logPath, loop.tailOffset).catch(
    () => null,
  );
  if (chunk && chunk.bytesRead > 0) {
    loop.tailOffset += chunk.bytesRead;
    await updateLoop(loop.id, { tailOffset: loop.tailOffset });
    for (const ev of parser.push(chunk.text)) {
      await handleEvent(api, loop, ev);
      if (finalizedLoopId === loop.id) return; // a terminal marker claimed it
    }
  }

  // 2. Completion check: exit file written or wrapper pid gone.
  const exitCode = await readExitFile(join(loop.runDir, "exit"));
  const alive = loop.pid ? isPidAlive(loop.pid) : true;
  if (exitCode === null && alive) return; // still running

  // Drain the final tail once more — a terminal marker in the last chunk sets
  // the real reason before we fall back to exit code / process-died.
  const rest = await readFromOffset(logPath, loop.tailOffset).catch(() => null);
  if (rest && rest.bytesRead > 0) {
    loop.tailOffset += rest.bytesRead;
    await updateLoop(loop.id, { tailOffset: loop.tailOffset });
    for (const ev of parser.push(rest.text)) {
      await handleEvent(api, loop, ev);
      if (finalizedLoopId === loop.id) return;
    }
  }
  // stopPending: the dying pid belongs to /ralph stop — let it claim the
  // "stopped" reason instead of finalizing process-died here.
  if (finalizedLoopId === loop.id || stopPending) return;

  if (exitCode !== null) {
    await finalize(
      api,
      loop,
      `exit:${exitCode}`,
      `🏁 loop finished (exit ${exitCode})`,
    );
  } else {
    await finalize(
      api,
      loop,
      "process-died",
      "🛑 loop process gone — terminal closed?",
    );
  }
}

// ---- public API -------------------------------------------------------------

export function startRalphMonitor(api: Api, loop: RalphLoop): void {
  stopRalphMonitor();
  parser = new RalphLogParser();
  stopPending = false;
  ++attachGen;
  intervalTimer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    tick(api, loop)
      .catch((err) => warn(`ralph: tick error: ${err}`))
      .finally(() => {
        ticking = false;
      });
  }, TICK_MS);
  info(`ralph: monitor started for loop ${loop.id}`);
}

/** Clear the tick interval only (used on shutdown). Does not finalize. */
export function stopRalphMonitor(): void {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}

/** Toggle verbose transcript streaming mid-loop. */
export async function setRalphVerbose(api: Api, on: boolean): Promise<boolean> {
  const loop = getActiveLoopSync() ?? (await getActiveLoop());
  if (!loop) return false;
  loop.verbose = on;
  await updateLoop(loop.id, { verbose: on });
  if (on) {
    void attachNewestNow(api, loop);
  } else if (loop.chatId !== undefined && loop.topicId !== undefined) {
    ++attachGen; // cancel any in-flight poll
    (await watch()).stopWatching(
      loop.chatId,
      loop.topicId,
      api,
      "ralph-verbose-off",
    );
  }
  return true;
}

/**
 * SIGTERM a process tree rooted at `pid`, wait 2s, SIGKILL survivors. Mirrors
 * afk_tasks.sh's kill_session. Also used by startCmd when a /ralph stop won
 * the race during the meta.json poll and the freshly learned pid must die.
 */
export async function killRalphTree(pid: number): Promise<void> {
  const tree = await collectTree(pid, defaultPgrep).catch(() => [pid]);
  for (const p of tree) {
    try {
      process.kill(p, "SIGTERM");
    } catch {
      // already gone
    }
  }
  await Bun.sleep(2_000);
  for (const p of tree) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Tree-kill the loop mid-iteration, then finalize as `stopped`. */
export async function stopRalphLoop(api: Api): Promise<boolean> {
  const loop = getActiveLoopSync() ?? (await getActiveLoop());
  if (!loop) return false;

  // Clear the interval AND flag the stop: clearing alone doesn't abort a tick
  // already suspended in an await — resumed, it would see the dying pid and
  // finalize as process-died, stealing the `stopped` reason. The flag makes
  // any in-flight tick bail at its next checkpoint instead.
  stopRalphMonitor();
  stopPending = true;

  if (loop.pid) await killRalphTree(loop.pid);

  const at = loop.lastIteration;
  const where = at ? `${at.n}/${at.total}` : `?/${loop.iterations}`;
  await finalize(api, loop, "stopped", `🛑 stopped at iter ${where}`);
  return true;
}

/**
 * Startup recovery: resume monitoring an active loop whose wrapper is still
 * alive, or finalize one that ended while the bridge was offline.
 */
export async function recoverRalphOnBoot(api: Api): Promise<void> {
  const loop = await getActiveLoop();
  if (!loop) return;

  if (loop.pid && isPidAlive(loop.pid)) {
    suppressDirNotifications(loop.repoPath, SUPPRESS_ITER_MS);
    startRalphMonitor(api, loop);
    info(`ralph: recovered active loop ${loop.id}, resuming monitor`);
    return;
  }

  // Wrapper dead — drain remaining log to find the true end state.
  parser = new RalphLogParser();
  stopPending = false;
  const chunk = await readFromOffset(
    join(loop.runDir, "run.log"),
    loop.tailOffset,
  ).catch(() => null);
  let terminal: { reason: string; desc: string } | null = null;
  if (chunk && chunk.bytesRead > 0) {
    loop.tailOffset += chunk.bytesRead;
    for (const ev of parser.push(chunk.text)) {
      if (ev.type === "iteration")
        loop.lastIteration = { n: ev.n, total: ev.total };
      const t = terminalFor(ev);
      if (t) terminal = t; // keep the last terminal marker
    }
  }

  if (terminal) {
    await finalize(
      api,
      loop,
      terminal.reason,
      `⚠️ loop ended while bridge was offline — ${terminal.desc}`,
    );
    return;
  }
  const exitCode = await readExitFile(join(loop.runDir, "exit"));
  if (exitCode !== null) {
    await finalize(
      api,
      loop,
      `exit:${exitCode}`,
      `⚠️ loop ended while bridge was offline — exit ${exitCode}`,
    );
  } else {
    await finalize(
      api,
      loop,
      "process-died",
      "⚠️ loop ended while bridge was offline — process gone",
    );
  }
}

function terminalFor(ev: RalphEvent): { reason: string; desc: string } | null {
  switch (ev.type) {
    case "complete":
      return {
        reason: "complete",
        desc: `COMPLETE after ${ev.iterations} iterations`,
      };
    case "no-issues":
      return { reason: "no-issues", desc: "no open issues" };
    case "max-iterations":
      return {
        reason: "max-iterations",
        desc: `reached max iterations (${ev.n})`,
      };
    default:
      return null;
  }
}
