import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";

let testDir: string;
let storePath: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "cron-test-"));
  storePath = join(testDir, "cron.json");
  process.env.CRON_STORE_PATH = storePath;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.CRON_STORE_PATH;
});

async function freshModule() {
  // bun caches modules; we mutate env at the top so re-evaluating the store
  // module per test isn't enough — instead just call _resetCronStoreForTesting
  // and rely on the static STORE_PATH binding for THIS process.
  const m = await import("../cron/store");
  m._resetCronStoreForTesting();
  return m;
}

describe("cron store", () => {
  it("returns empty list when no file exists", async () => {
    const m = await freshModule();
    expect(await m.getJobs()).toEqual([]);
  });

  it("addJob persists across reads", async () => {
    const m = await freshModule();
    await m.addJob({
      schedule: "*/5 * * * *",
      sessionName: "proj",
      prompt: "ping",
      enabled: true,
    });
    const jobs = await m.getJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.schedule).toBe("*/5 * * * *");
    expect(jobs[0]?.id).toBeTruthy();
    expect(jobs[0]?.createdAt).toBeTruthy();
  });

  it("removeJob deletes by id", async () => {
    const m = await freshModule();
    const j = await m.addJob({
      schedule: "* * * * *",
      sessionName: "p",
      prompt: "x",
      enabled: true,
    });
    expect(await m.removeJob(j.id)).toBe(true);
    expect(await m.getJobs()).toHaveLength(0);
    expect(await m.removeJob("nope")).toBe(false);
  });

  it("setEnabled flips and persists", async () => {
    const m = await freshModule();
    const j = await m.addJob({
      schedule: "* * * * *",
      sessionName: "p",
      prompt: "x",
      enabled: true,
    });
    expect(await m.setEnabled(j.id, false)).toBe(true);
    const fresh = await m.getJobs();
    expect(fresh[0]?.enabled).toBe(false);
  });

  it("writes a JSON file on the filesystem", async () => {
    const m = await freshModule();
    await m.addJob({
      schedule: "0 9 * * *",
      sessionName: "p",
      prompt: "daily",
      enabled: true,
    });
    await Bun.sleep(350); // wait for debounced save
    expect(existsSync(storePath)).toBe(true);
    const data = JSON.parse(await Bun.file(storePath).text());
    expect(data.jobs?.[0]?.prompt).toBe("daily");
  });

  it("markRun updates lastRunAt", async () => {
    const m = await freshModule();
    const j = await m.addJob({
      schedule: "* * * * *",
      sessionName: "p",
      prompt: "x",
      enabled: true,
    });
    const when = new Date("2026-05-31T09:00:00.000Z");
    await m.markRun(j.id, when);
    const jobs = await m.getJobs();
    expect(jobs[0]?.lastRunAt).toBe(when.toISOString());
  });
});
