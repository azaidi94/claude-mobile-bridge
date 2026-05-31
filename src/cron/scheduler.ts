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
import { getTopicBySession } from "../topics";
import { getMessageBus } from "../messaging";
import { getRelayClient } from "../relay/discovery";
import { info, warn, debug } from "../logger";

let tickTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

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
  const topic = getTopicBySession(job.sessionName);
  const threadId = topic?.topicId;

  const headerLines = [
    `⏰ <b>cron</b> <code>${job.schedule}</code>`,
    `<i>${job.prompt}</i>`,
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
    warn(`cron: relay attempt failed: ${err}`);
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
    warn(`cron: header post failed: ${err}`);
  }

  await markRun(job.id, now);
  info(
    `cron: fired job=${job.id} session=${job.sessionName} relayed=${relayed}`,
  );
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
      warn(
        `cron: job ${job.id} has invalid schedule "${job.schedule}": ${err}`,
      );
      continue;
    }
    if (!matchesAt(expr, boundary)) continue;
    if (ranAt(job, boundary)) {
      debug(`cron: skipping duplicate fire for ${job.id}`);
      continue;
    }
    await fireJob(api, chatId, job, boundary);
  }
}

/** Sleep until the next minute boundary, then run the supplied tick. */
function msUntilNextMinute(now: Date = new Date()): number {
  return 60_000 - (now.getTime() % 60_000);
}

export function startCronScheduler(api: Api, chatId: number): void {
  if (tickTimer) return;
  stopped = false;
  const schedule = () => {
    if (stopped) return;
    tickTimer = setTimeout(async () => {
      try {
        await tick(api, chatId, new Date());
      } catch (err) {
        warn(`cron: tick failed: ${err}`);
      }
      schedule();
    }, msUntilNextMinute());
  };
  info(`cron: scheduler started (chatId=${chatId})`);
  schedule();
}

export function stopCronScheduler(): void {
  stopped = true;
  if (tickTimer) clearTimeout(tickTimer);
  tickTimer = null;
}
