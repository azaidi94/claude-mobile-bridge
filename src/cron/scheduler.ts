/**
 * Minute-resolution cron tick. Started at bot boot via startCronScheduler();
 * pauses cleanly on shutdown. Each tick:
 *
 *   1. Loads jobs from the store
 *   2. Re-parses each schedule (cheap; lets bad specs be flagged and skipped)
 *   3. Filters: enabled && matchesAt(now) && not already fired this minute
 *   4. Fires each match via fireJob (sends a labelled message into the
 *      session's topic + relays the prompt to the running session)
 *
 * Duplicate-fire protection: each fired job's lastRunAt is stamped with the
 * current tick's minute-boundary, so re-entering the same tick (e.g. drift)
 * won't double-fire.
 */

import type { Api } from "grammy";
import { parseCron, matchesAt } from "./parser";
import { getJobs, markRun, type CronJob } from "./store";
import { topicForSession } from "../topics/topic-store";
import { getSession } from "../sessions";
import { launchUuidForPid } from "../sessions/resolve-session";
import { getMessageBus } from "../messaging";
import { getRelayClient } from "../relay/discovery";
import { escapeHtml } from "../formatting";
import { info, warn, debug } from "../logger";

let tickTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let lastEvaluatedMinute = 0;

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

/**
 * Single tick: examine all jobs against `now`. Exported for tests so they
 * can drive a deterministic clock instead of waiting on setTimeout.
 */
export async function tick(api: Api, chatId: number, now: Date): Promise<void> {
  const boundary = toMinuteBoundary(now);
  const jobs = await getJobs();
  for (const job of jobs) {
    if (!job.enabled) continue;
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
    if (!matchesAt(expr, boundary)) continue;
    if (ranAt(job, boundary)) {
      debug("cron: skipping duplicate fire", { jobId: job.id });
      continue;
    }
    await fireJob(api, chatId, job, boundary);
  }
}

/**
 * Evaluate all cron jobs for each minute boundary between lastMinute+1
 * and nowMinute (capped at MAX_CATCHUP). Returns the new last evaluated
 * minute. Exported for testability so tests can inject fake clock values.
 */
export async function evaluateMissedMinutes(
  api: Api,
  chatId: number,
  nowMinute: number,
  lastMinute: number,
): Promise<number> {
  const MAX_CATCHUP = 5;
  for (
    let m = lastMinute + 1;
    m <= Math.min(nowMinute, lastMinute + MAX_CATCHUP);
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

export function stopCronScheduler(): void {
  stopped = true;
  if (tickTimer) clearTimeout(tickTimer);
  tickTimer = null;
}
