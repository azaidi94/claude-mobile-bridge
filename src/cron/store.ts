/**
 * Persistent registry for cron jobs at ~/.claude-mobile-bridge/cron.json.
 * Stored as plain JSON; reads happen at scheduler start and on every
 * /cron mutation, writes are debounced to avoid hammering the disk when
 * /cron add is called rapidly.
 */

import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import { homedir } from "os";
import { info, warn } from "../logger";

export interface CronJob {
  id: string;
  schedule: string; // raw cron spec — re-parsed each tick (cheap)
  sessionName: string; // routed via topic-store
  prompt: string;
  enabled: boolean;
  createdAt: string; // ISO 8601 UTC
  lastRunAt?: string; // ISO 8601 UTC
}

interface CronStore {
  jobs: CronJob[];
}

function storePath(): string {
  return (
    process.env.CRON_STORE_PATH ||
    `${homedir()}/.claude-mobile-bridge/cron.json`
  );
}

let cache: CronStore = { jobs: [] };
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function ensureDir(): Promise<void> {
  const dir = dirname(storePath());
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

async function load(): Promise<void> {
  if (loaded) return;
  try {
    if (existsSync(storePath())) {
      const raw = await readFile(storePath(), "utf-8");
      const parsed = JSON.parse(raw) as CronStore;
      if (parsed && Array.isArray(parsed.jobs)) cache = parsed;
    }
  } catch (err) {
    warn(`cron-store: load failed, starting empty: ${err}`);
    cache = { jobs: [] };
  }
  loaded = true;
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void persist();
  }, 250);
}

async function persist(): Promise<void> {
  await ensureDir();
  const tmp = `${storePath()}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2));
  await rename(tmp, storePath());
}

export async function getJobs(): Promise<CronJob[]> {
  await load();
  return [...cache.jobs];
}

export async function addJob(
  job: Omit<CronJob, "id" | "createdAt"> & {
    id?: string;
  },
): Promise<CronJob> {
  await load();
  const id =
    job.id ||
    `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const created: CronJob = {
    id,
    schedule: job.schedule,
    sessionName: job.sessionName,
    prompt: job.prompt,
    enabled: job.enabled,
    createdAt: new Date().toISOString(),
  };
  cache.jobs.push(created);
  scheduleSave();
  info(`cron-store: added job ${id} (${job.schedule})`);
  return created;
}

export async function removeJob(id: string): Promise<boolean> {
  await load();
  const before = cache.jobs.length;
  cache.jobs = cache.jobs.filter((j) => j.id !== id);
  if (cache.jobs.length !== before) {
    scheduleSave();
    info(`cron-store: removed job ${id}`);
    return true;
  }
  return false;
}

export async function setEnabled(
  id: string,
  enabled: boolean,
): Promise<boolean> {
  await load();
  const job = cache.jobs.find((j) => j.id === id);
  if (!job) return false;
  job.enabled = enabled;
  scheduleSave();
  return true;
}

export async function markRun(id: string, at: Date): Promise<void> {
  await load();
  const job = cache.jobs.find((j) => j.id === id);
  if (!job) return;
  job.lastRunAt = at.toISOString();
  scheduleSave();
}

/** Test seam: reset cache + cancel pending save. */
export function _resetCronStoreForTesting(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  cache = { jobs: [] };
  loaded = false;
}
