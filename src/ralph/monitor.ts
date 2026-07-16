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
import { info, warn, debug } from "../logger";
import { getMessageBus } from "../messaging";
import { suppressDirNotifications } from "../sessions";
import { escapeHtml } from "../formatting";
import { scanPortFiles, type PortFileData } from "../relay";
import type { SessionInfo } from "../sessions/types";
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

/**
 * Detach any session-topic watch bound to the loop's repo dir so the loop's
 * ephemeral iteration claudes (which share the repo's session name) can't leak
 * their transcript into an unrelated topic. Exempts the loop's own beat topic.
 * Fire-and-forget: the dynamic import is async but the teardown itself is sync.
 */
async function quiesceRepoWatches(api: Api, loop: RalphLoop): Promise<void> {
  const except =
    loop.chatId !== undefined && loop.topicId !== undefined
      ? { chatId: loop.chatId, threadId: loop.topicId }
      : undefined;
  const n = (await watch()).stopWatchesForDir(
    loop.repoPath,
    api,
    "ralph-owns-dir",
    except,
  );
  if (n > 0)
    info("ralph: quiesced session-topic watches on repo", {
      loopId: loop.id,
      count: n,
    });
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

/** Post a beat; returns the sent message id (undefined on drop/error). */
async function post(
  api: Api,
  loop: RalphLoop,
  content: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<number | undefined> {
  if (loop.chatId === undefined) return undefined;
  const res = await getMessageBus()
    .send({
      chatId: loop.chatId,
      threadId: loop.topicId,
      content,
      format: "html",
      replyMarkup,
    })
    .catch((err) => {
      debug("ralph: post failed", {
        err: String(err),
        topic: loop.topicId,
        chatId: loop.chatId,
      });
      return undefined;
    });
  return res && "messageId" in res ? res.messageId : undefined;
}

/**
 * Pin `messageId` as the topic's current-progress marker and unpin the previous
 * one, so the pinned message always reflects where the loop is at. Silent on
 * failure (missing pin rights shouldn't break the loop).
 */
export async function pinLatest(
  api: Api,
  loop: RalphLoop,
  messageId: number,
): Promise<void> {
  if (loop.chatId === undefined) return;
  const prev = loop.pinnedMessageId;
  try {
    await api.pinChatMessage(loop.chatId, messageId, {
      disable_notification: true,
    });
    loop.pinnedMessageId = messageId;
    await updateLoop(loop.id, { pinnedMessageId: messageId });
    if (prev !== undefined && prev !== messageId) {
      await api.unpinChatMessage(loop.chatId, prev).catch(() => {});
    }
  } catch (err) {
    debug("ralph: pin failed", {
      err: String(err),
      topic: loop.topicId,
      chatId: loop.chatId,
    });
  }
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Final wrap-up block shown above the delete-topic button. */
function completionSummary(
  loop: RalphLoop,
  final: IssueSummary | null,
): string {
  const lines = ["📋 <b>Loop summary</b>"];
  lines.push(
    `⏱ ran for ${fmtDuration(Date.now() - Date.parse(loop.startedAt))}`,
  );
  const done = loop.lastIteration?.n ?? 0;
  lines.push(`🔁 ${done}/${loop.iterations} iterations`);
  if (loop.initialIssueCount !== undefined && final) {
    const closed = Math.max(0, loop.initialIssueCount - final.count);
    lines.push(`✅ ${closed} issue${closed === 1 ? "" : "s"} closed`);
  }
  if (final) {
    lines.push(
      `📊 ${final.count} issue${final.count === 1 ? "" : "s"} still open`,
    );
  }
  return lines.join("\n");
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

/** Port-file birth time in ms (0 when absent/unparseable) — newest-wins key. */
function portStartedMs(p: PortFileData): number {
  const t = Date.parse(p.startedAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Identify the loop's current iteration claude by walking the runner's process
 * tree and matching it to a relay port file in the repo, returning a
 * SessionInfo pinned to that claude's PID + live sessionId. This is the ONLY
 * reliable way to pick the iteration out of the several same-named `athletiq`
 * sessions the name-keyed registry collapses to one. Null until an iteration
 * claude with a live relay exists in the tree.
 *
 * Exported (underscore-prefixed) as a test seam with injectable `pgrep`/`scan`,
 * mirroring how `collectTree` takes an injectable pgrep.
 */
export async function _resolveIterationClaude(
  loop: RalphLoop,
  deps?: {
    pgrep?: (pid: number) => Promise<number[]>;
    scan?: (force?: boolean) => Promise<PortFileData[]>;
  },
): Promise<SessionInfo | null> {
  if (!loop.pid) return null;
  const pgrep = deps?.pgrep ?? defaultPgrep;
  const scan = deps?.scan ?? scanPortFiles;
  const tree = await collectTree(loop.pid, pgrep).catch(() => []);
  if (tree.length === 0) return null;
  const treeSet = new Set(tree);
  const repo = tryRealpath(loop.repoPath);
  const ports = await scan(true).catch(() => []);
  // A relay port file's `ppid` is the Claude PID that spawned it; keep the ones
  // that are both a descendant of the runner and rooted in the repo dir.
  const matches = ports.filter(
    (p) =>
      !!p.sessionId &&
      p.ppid !== undefined &&
      treeSet.has(p.ppid) &&
      tryRealpath(p.cwd) === repo,
  );
  if (matches.length === 0) return null;
  // More than one can match — a dying iteration's relay overlapping the next
  // (timeout/retry), or a subagent carrying its own port file. Prefer the
  // newest (latest port-file birth time; highest ppid breaks ties) so a plain
  // `.find` never pins the stale/dying claude.
  matches.sort(
    (a, b) =>
      portStartedMs(b) - portStartedMs(a) || (b.ppid ?? 0) - (a.ppid ?? 0),
  );
  const pf = matches[0]!;
  return {
    id: pf.sessionId!,
    // Synthetic name so this never cross-wires with the registry's collapsed
    // `athletiq` entry — the pinned watch resolves by PID, not name.
    name: `ralph:${loop.id}`,
    // The matched port file's OWN cwd, not loop.repoPath: the pinned drift loop
    // compares `cwd` by exact string, so under a symlinked repo path both sides
    // must use the same string or /clear-follow silently stops.
    dir: pf.cwd,
    lastActivity: Date.now(),
    source: "desktop",
    pid: pf.ppid,
  };
}

/**
 * Pin the loop topic to `iter`'s PID, then—if a newer attach superseded us
 * while startPinnedWatch was in flight (finalize / verbose-off / next iteration
 * bumped `attachGen` after its stopWatching ran)—tear the watch back down so it
 * can't leak past the loop's end. Shared resolve→pin→stale-check tail of both
 * attach paths.
 */
async function pinIfCurrent(
  api: Api,
  loop: RalphLoop,
  iter: SessionInfo,
  gen: number,
): Promise<void> {
  const { chatId, topicId } = loop;
  if (chatId === undefined || topicId === undefined) return;
  const w = await watch();
  await w
    .startPinnedWatch(api, chatId, topicId, iter)
    .catch((err) =>
      debug("ralph: verbose attach failed", { err: String(err) }),
    );
  if (gen !== attachGen) {
    w.stopWatching(chatId, topicId, api, "ralph-stale-attach");
  }
}

/** Poll for the loop's iteration claude, then pin the loop topic to its PID. */
async function attachVerboseWatch(api: Api, loop: RalphLoop): Promise<void> {
  const { chatId, topicId } = loop;
  if (chatId === undefined || topicId === undefined) return;
  const gen = ++attachGen;
  const w = await watch();
  w.stopWatching(chatId, topicId, api, "ralph-iter");

  const deadline = Date.now() + VERBOSE_ATTACH_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (gen !== attachGen) return; // superseded (newer iteration / verbose off)
    const iter = await _resolveIterationClaude(loop);
    if (iter && gen === attachGen) {
      await pinIfCurrent(api, loop, iter, gen);
      return;
    }
    await Bun.sleep(2_000);
  }
  info("ralph: verbose watch — no iteration claude appeared this iteration");
}

/** Verbose toggled on mid-loop: pin to the iteration claude if one exists now. */
async function attachNewestNow(api: Api, loop: RalphLoop): Promise<void> {
  const { chatId, topicId } = loop;
  if (chatId === undefined || topicId === undefined) return;
  const gen = ++attachGen; // cancel any in-flight per-iteration poll
  const w = await watch();
  w.stopWatching(chatId, topicId, api, "ralph-verbose-on");
  const iter = await _resolveIterationClaude(loop);
  if (gen !== attachGen) return; // superseded while resolving
  if (!iter) return; // nothing running yet — next iteration will attach
  await pinIfCurrent(api, loop, iter, gen);
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
      // Baseline the open-issue count on the first iteration we can read it, so
      // finalize can report how many closed over the run.
      if (summary && loop.initialIssueCount === undefined) {
        loop.initialIssueCount = summary.count;
        await updateLoop(loop.id, { initialIssueCount: summary.count });
      }
      let content = `🔄 iter ${ev.n}/${ev.total}`;
      if (summary) {
        content += ` · ${summary.count} issue${summary.count === 1 ? "" : "s"} open`;
        if (summary.next) {
          content += ` · next: #${summary.next.number} ${escapeHtml(
            summary.next.title,
          )}`;
        }
      }
      // Pin each iteration beat so the pinned message tracks current progress.
      const id = await post(api, loop, content);
      if (id !== undefined) await pinLatest(api, loop, id);
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
  const summary = await ghIssueSummary(loop);
  await post(api, loop, finalBeat);
  // On a natural finish (and only with a real forum topic to delete), post a
  // wrap-up block carrying the delete-topic button, and pin it so the topic's
  // pinned message is the final outcome. Otherwise keep the old bare remaining
  // count with no button.
  if (loop.topicId !== undefined && isNaturalCompletion(reason)) {
    const id = await post(
      api,
      loop,
      completionSummary(loop, summary),
      deleteTopicKeyboard(loop),
    );
    if (id !== undefined) await pinLatest(api, loop, id);
  } else if (summary) {
    await post(
      api,
      loop,
      `📊 ${summary.count} open issue${summary.count === 1 ? "" : "s"} remaining`,
    );
  }
  await flush();
  info("ralph: finalized loop", { loopId: loop.id, reason });
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
  // Tear down any pre-existing session-topic watch on the loop's repo. The
  // loop's ephemeral iteration claudes share the repo's session name, so an
  // already-attached watch would resolve that name to a loop iteration and leak
  // its transcript into the wrong topic. The drift/auto-watch guards keep new
  // ones from re-attaching; this clears the ones already running. Exempt the
  // loop's own beat topic (its verbose watch lives there).
  void quiesceRepoWatches(api, loop);
  intervalTimer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    tick(api, loop)
      .catch((err) => warn("ralph: tick error", err, { loopId: loop.id }))
      .finally(() => {
        ticking = false;
      });
  }, TICK_MS);
  info("ralph: monitor started", { loopId: loop.id });
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
    info("ralph: recovered active loop, resuming monitor", { loopId: loop.id });
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
