/**
 * Minute-resolution cron tick. Started at bot boot via startCronScheduler();
 * pauses cleanly on shutdown. Each tick:
 *
 *   1. Loads jobs from the store
 *   2. Re-parses each schedule (cheap; lets bad specs be flagged and skipped)
 *   3. Filters: enabled && matchesAt(now) && not already fired this minute
 *   4. Fires each match via fireJob (sends a labelled message into the
 *      session's topic + relays the prompt to the running session), or
 *      fireRalphJob for kind=ralph (starts a ralph loop, reports to General)
 *
 * One-shot jobs (`runAt`) skip the cron match: they fire on the first tick at
 * or after `runAt` and are removed (and flushed) first, so a crash can't
 * re-fire them. A one-shot found more than ONCE_GRACE_MS late (bot was
 * offline) is dropped with a "missed" notice rather than started at a
 * surprising hour.
 *
 * Duplicate-fire protection: each fired job's lastRunAt is stamped with the
 * current tick's minute-boundary, so re-entering the same tick (e.g. drift)
 * won't double-fire. Local-tz jobs also skip a repeat of the same wall-clock
 * minute within 2h — the DST fall-back hour. (Spring-forward's missing hour is
 * simply skipped.)
 */

import type { Api } from "grammy";
import { parseCron, matchesAt } from "./parser";
import { getJobs, markRun, removeJob, flush, type CronJob } from "./store";
import { topicForSession } from "../topics/topic-store";
import { getSession } from "../sessions";
import { launchUuidForPid } from "../sessions/resolve-session";
import { getMessageBus } from "../messaging";
import { getRelayClient } from "../relay/discovery";
import { escapeHtml, formatLocalDateTime } from "../formatting";
import { info, warn, error, debug } from "../logger";

let tickTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let lastEvaluatedMinute = 0;

const ONCE_GRACE_MS = 60 * 60_000;

// A scheduled ralph start is in flight (startRalphLoop is not awaited, so a
// second job in the same tick would pass the busy check before addLoop runs).
let ralphStarting = false;

/** Round a Date down to the start of its minute. */
function toMinuteBoundary(d: Date): Date {
  const copy = new Date(d);
  copy.setUTCSeconds(0, 0);
  return copy;
}

/** Was this job already run at this exact minute boundary? */
function ranAt(job: CronJob, when: Date): boolean {
  if (!job.lastRunAt) return false;
  return new Date(job.lastRunAt).getTime() === when.getTime();
}

/**
 * Local-tz only: did this job already fire at the same wall-clock HH:MM within
 * the last 2h? True only across the DST fall-back hour, where e.g. 01:30
 * occurs twice.
 */
function ranSameLocalMinute(job: CronJob, when: Date): boolean {
  if (job.tz !== "local" || !job.lastRunAt) return false;
  const last = new Date(job.lastRunAt);
  return (
    when.getTime() - last.getTime() <= 2 * 3_600_000 &&
    last.getHours() === when.getHours() &&
    last.getMinutes() === when.getMinutes()
  );
}

async function fireJob(
  api: Api,
  chatId: number,
  job: CronJob,
  now: Date,
): Promise<void> {
  const topic = topicForSession({
    launchUuid: launchUuidForPid(getSession(job.sessionName)?.pid),
    sessionName: job.sessionName,
  });
  const threadId = topic?.topicId;

  const headerLines = [
    `⏰ <b>cron</b> <code>${escapeHtml(job.schedule)}</code>`,
    `<i>${escapeHtml(job.prompt)}</i>`,
  ];

  let relayed = false;
  try {
    const client = await getRelayClient({
      sessionDir: topic?.sessionDir,
      sessionId: topic?.sessionId,
    });
    if (client) {
      relayed = client.sendMessage({
        chat_id: String(chatId),
        user: "cron",
        text: job.prompt,
      });
    }
  } catch (err) {
    warn("cron: relay attempt failed", err, { session: job.sessionName });
  }
  if (!relayed) {
    headerLines.push("⚠️ session offline — prompt not delivered");
  }

  try {
    await getMessageBus().send({
      chatId,
      threadId,
      content: headerLines.join("\n"),
      format: "html",
      silent: true,
    });
  } catch (err) {
    warn("cron: header post failed", err, {
      session: job.sessionName,
      topic: threadId,
    });
  }

  await markRun(job.id, now);
  info("cron: fired job", {
    jobId: job.id,
    session: job.sessionName,
    relayed,
  });
}

/** Start a scheduled ralph loop; results go to General of `chatId`. */
async function fireRalphJob(
  api: Api,
  chatId: number,
  job: CronJob,
  now: Date,
): Promise<void> {
  await markRun(job.id, now);
  // Never throws: a failed notice must not abort the tick, nor abort
  // startRalphLoop mid-spawn (that would strand the loop record in "starting").
  const post = (html: string) =>
    getMessageBus()
      .send({
        chatId,
        content: `⏰ <b>scheduled ralph</b> <code>${escapeHtml(job.id)}</code>\n${html}`,
        format: "html",
      })
      .catch((err) =>
        warn("cron: ralph notice failed", err, { jobId: job.id, chatId }),
      );
  if (!job.ralph) {
    warn("cron: ralph job missing args", undefined, { jobId: job.id });
    return;
  }
  // Dynamic imports keep the ralph/Telegram-handler graph out of the
  // scheduler's static deps (and its tests).
  const { getActiveLoop } = await import("../ralph/store");
  const busy = await getActiveLoop();
  if (busy || ralphStarting) {
    await post(
      busy
        ? `⏭ skipped — loop busy on <code>${escapeHtml(busy.repoPath)}</code>`
        : "⏭ skipped — another scheduled loop is starting",
    );
    info("cron: ralph job skipped, loop busy", { jobId: job.id });
    return;
  }
  const { startRalphLoop } = await import("../handlers/commands/ralph");
  const repo = job.ralph.path;
  ralphStarting = true;
  // Don't await: startRalphLoop polls up to 30s for the runner pid, which
  // would stall every other job in this tick.
  startRalphLoop(api, job.ralph, { chatId, reply: post })
    .then((ok) => {
      if (ok) info("cron: fired ralph job", { jobId: job.id, repo });
      // startRalphLoop already posted the reason.
      else
        warn("cron: ralph job did not start", undefined, {
          jobId: job.id,
          repo,
        });
    })
    .catch((err) => {
      error("cron: ralph job start failed", err, { jobId: job.id, repo });
      void post(
        `❌ scheduled start failed: <code>${escapeHtml(String(err))}</code>`,
      );
    })
    .finally(() => {
      ralphStarting = false;
    });
}

function fire(
  api: Api,
  chatId: number,
  job: CronJob,
  now: Date,
): Promise<void> {
  return job.kind === "ralph"
    ? fireRalphJob(api, chatId, job, now)
    : fireJob(api, chatId, job, now);
}

/** One-shot: fire once due (within grace), dropping the job either way. */
async function tickOnce(
  api: Api,
  chatId: number,
  job: CronJob,
  now: Date,
): Promise<void> {
  const due = Date.parse(job.runAt!);
  if (!Number.isFinite(due)) {
    warn("cron: one-shot job has invalid runAt", undefined, {
      jobId: job.id,
      runAt: job.runAt,
    });
    await removeJob(job.id);
    return;
  }
  if (now.getTime() < due) return;
  // Lost a race with /ralph unsched mid-tick → it's gone, don't fire.
  if (!(await removeJob(job.id))) return;
  await flush();
  if (now.getTime() - due > ONCE_GRACE_MS) {
    warn("cron: one-shot job missed, dropped", undefined, {
      jobId: job.id,
      runAt: job.runAt,
    });
    await getMessageBus()
      .send({
        chatId,
        content: `⏭ missed scheduled job <code>${escapeHtml(job.id)}</code> (due ${escapeHtml(
          formatLocalDateTime(new Date(due)),
        )}, bot was offline) — dropped`,
        format: "html",
      })
      .catch((err) => warn("cron: missed notice failed", err));
    return;
  }
  await fire(api, chatId, job, now);
}

/**
 * Single tick: examine all jobs against `now`. Exported for tests so they
 * can drive a deterministic clock instead of waiting on setTimeout.
 */
export async function tick(api: Api, chatId: number, now: Date): Promise<void> {
  const boundary = toMinuteBoundary(now);
  const jobs = await getJobs();
  for (const job of jobs) {
    if (!job.enabled) continue;
    if (job.runAt) {
      await tickOnce(api, chatId, job, boundary);
      continue;
    }
    let expr;
    try {
      expr = parseCron(job.schedule);
    } catch (err) {
      warn("cron: job has invalid schedule", err, {
        jobId: job.id,
        schedule: job.schedule,
      });
      continue;
    }
    if (!matchesAt(expr, boundary, job.tz === "local")) continue;
    if (ranAt(job, boundary) || ranSameLocalMinute(job, boundary)) {
      debug("cron: skipping duplicate fire", { jobId: job.id });
      continue;
    }
    await fire(api, chatId, job, boundary);
  }
}

/**
 * Evaluate all cron jobs for each minute boundary between lastMinute+1
 * and nowMinute, capped to the MOST RECENT MAX_CATCHUP minutes — replaying the
 * oldest missed minutes after a long host sleep would start a 02:00 job at
 * 08:30. Returns the new last evaluated minute. Exported for testability so
 * tests can inject fake clock values.
 */
export async function evaluateMissedMinutes(
  api: Api,
  chatId: number,
  nowMinute: number,
  lastMinute: number,
): Promise<number> {
  const MAX_CATCHUP = 5;
  for (
    let m = Math.max(lastMinute + 1, nowMinute - MAX_CATCHUP + 1);
    m <= nowMinute;
    m++
  ) {
    const minuteDate = new Date(m * 60_000);
    await tick(api, chatId, minuteDate);
  }
  if (nowMinute > lastMinute + MAX_CATCHUP) {
    warn("cron: minutes elapsed; skipping missed minutes", undefined, {
      elapsed: nowMinute - lastMinute,
      skipped: nowMinute - lastMinute - MAX_CATCHUP,
    });
  }
  return nowMinute;
}

/** Sleep until the next minute boundary, then run the supplied tick. */
function msUntilNextMinute(now: Date = new Date()): number {
  return 60_000 - (now.getTime() % 60_000);
}

export function startCronScheduler(api: Api, chatId: number): void {
  if (tickTimer) return;
  stopped = false;
  lastEvaluatedMinute = Math.floor(Date.now() / 60_000);
  const schedule = () => {
    if (stopped) return;
    tickTimer = setTimeout(
      async () => {
        try {
          const nowMinute = Math.floor(Date.now() / 60_000);
          lastEvaluatedMinute = await evaluateMissedMinutes(
            api,
            chatId,
            nowMinute,
            lastEvaluatedMinute,
          );
        } catch (err) {
          warn("cron: tick failed", err);
        }
        schedule();
      },
      Math.max(0, msUntilNextMinute()),
    );
  };
  info("cron: scheduler started", { chatId });
  schedule();
}

/** False when boot had no primary chat (jobs would never fire). */
export function isCronSchedulerRunning(): boolean {
  return tickTimer !== null && !stopped;
}

export function stopCronScheduler(): void {
  stopped = true;
  if (tickTimer) clearTimeout(tickTimer);
  tickTimer = null;
}
