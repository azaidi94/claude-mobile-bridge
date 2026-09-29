import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir, homedir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";

// Force desktop-spawn support so the already-running path is reached on any
// platform (config reads this at load time; set before the dynamic import).
process.env.TELEGRAM_BOT_DESKTOP_SPAWN_ANY_PLATFORM = "1";
// Pin a DST-observing zone so scheduling tests are deterministic on any host.
process.env.TZ = "Europe/London";

// Capture outbound bus messages.
const sends: { content: string }[] = [];
mock.module("../messaging", () => ({
  getMessageBus: () => ({
    send: async (m: { content: string }) => {
      sends.push(m);
      return { messageId: 1 };
    },
    edit: async () => ({}),
  }),
  setMessageBus: () => {},
  createMessageBus: () => ({}),
}));

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ralph-cmd-"));
  process.env.RALPH_STORE_PATH = join(testDir, "ralph.json");
  process.env.CRON_STORE_PATH = join(testDir, "cron.json");
  sends.length = 0;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.RALPH_STORE_PATH;
  delete process.env.CRON_STORE_PATH;
});

async function loadCmd() {
  const store = await import("../ralph/store");
  store._resetRalphStoreForTesting();
  (await import("../cron/store"))._resetCronStoreForTesting();
  const cmd = await import("../handlers/commands/ralph");
  return { store, cmd };
}

function mkCtx(text: string, userId = 1) {
  return {
    from: { id: userId },
    chat: { id: 789, type: "private" },
    message: { text, message_id: 1 },
    api: { createForumTopic: async () => ({ message_thread_id: 5 }) },
  } as any;
}

function baseLoop(over: Record<string, unknown> = {}) {
  return {
    id: "seed",
    repoPath: "/tmp/repo",
    iterations: 10,
    prMode: false,
    runDir: join(testDir, "run-seed"),
    tailOffset: 0,
    verbose: false,
    startedAt: "2026-07-05T00:00:00.000Z",
    ...over,
  };
}

describe("parseStartArgs", () => {
  it("defaults iterations to 10", async () => {
    const { cmd } = await loadCmd();
    expect(cmd.parseStartArgs("/tmp/x")).toEqual({
      path: "/tmp/x",
      iterations: 10,
      prMode: false,
      label: undefined,
    });
  });

  it("parses N, -pr and -l label in any order", async () => {
    const { cmd } = await loadCmd();
    expect(cmd.parseStartArgs("-pr /tmp/x -l bug 5")).toEqual({
      path: "/tmp/x",
      iterations: 5,
      prMode: true,
      label: "bug",
    });
  });

  it("errors on missing path", async () => {
    const { cmd } = await loadCmd();
    expect(cmd.parseStartArgs("5 -pr")).toEqual({ error: "need a repo path" });
  });

  it("rejects 0 iterations", async () => {
    const { cmd } = await loadCmd();
    expect(cmd.parseStartArgs("/tmp/x 0")).toEqual({
      error: "iterations must be ≥ 1",
    });
  });
});

describe("expandHome", () => {
  it("expands ~ and ~/sub", async () => {
    const { cmd } = await loadCmd();
    expect(cmd.expandHome("~")).toBe(homedir());
    expect(cmd.expandHome("~/proj")).toBe(join(homedir(), "proj"));
    expect(cmd.expandHome("/abs")).toBe("/abs");
  });
});

describe("resolveRalphLabel", () => {
  it("falls back to the configured default when -l absent", async () => {
    const { cmd } = await loadCmd();
    expect(cmd.resolveRalphLabel(undefined, "ralph")).toBe("ralph");
    expect(cmd.resolveRalphLabel(undefined, "  spaced  ")).toBe("spaced");
  });

  it("treats empty/blank default as no label", async () => {
    const { cmd } = await loadCmd();
    expect(cmd.resolveRalphLabel(undefined, "")).toBeUndefined();
    expect(cmd.resolveRalphLabel(undefined, "   ")).toBeUndefined();
  });

  it("`-l -` forces no label even with a default set", async () => {
    const { cmd } = await loadCmd();
    expect(cmd.resolveRalphLabel("-", "ralph")).toBeUndefined();
  });

  it("an explicit label overrides the default", async () => {
    const { cmd } = await loadCmd();
    expect(cmd.resolveRalphLabel("bug", "ralph")).toBe("bug");
  });
});

describe("handleRalph", () => {
  it("rejects unauthorized users", async () => {
    const { cmd } = await loadCmd();
    await cmd.handleRalph(mkCtx("/ralph", 999));
    expect(sends.at(-1)?.content).toContain("Unauthorized");
  });

  it("reports no loop on /ralph stop when none running", async () => {
    const { cmd } = await loadCmd();
    await cmd.handleRalph(mkCtx("/ralph stop"));
    expect(sends.at(-1)?.content).toContain("No loop running");
  });

  it("rejects start when a loop is already active", async () => {
    const { store, cmd } = await loadCmd();
    await store.addLoop(baseLoop({ state: "running", pid: 1 }));
    await cmd.handleRalph(mkCtx("/ralph /tmp/other 5"));
    expect(sends.at(-1)?.content).toContain("already running");
  });

  it("shows usage-style status when idle", async () => {
    const { cmd } = await loadCmd();
    await cmd.handleRalph(mkCtx("/ralph"));
    expect(sends.at(-1)?.content).toContain("No loop running");
  });
});

describe("nextLocalTime", () => {
  it("returns today when the time is still ahead", async () => {
    const { cmd } = await loadCmd();
    const now = new Date(2026, 8, 29, 22, 0);
    expect(cmd.nextLocalTime("23:15", now)).toEqual(
      new Date(2026, 8, 29, 23, 15),
    );
  });

  it("rolls to tomorrow when the time has passed (or is now)", async () => {
    const { cmd } = await loadCmd();
    const now = new Date(2026, 8, 29, 22, 0);
    expect(cmd.nextLocalTime("2:00", now)).toEqual(new Date(2026, 8, 30, 2, 0));
    expect(cmd.nextLocalTime("22:00", now)).toEqual(
      new Date(2026, 8, 30, 22, 0),
    );
  });

  it("keeps the wall-clock time across a DST change", async () => {
    const { cmd } = await loadCmd();
    // 2026-03-29 is UK spring-forward (01:00→02:00); tomorrow 01:30 is real.
    const at = cmd.nextLocalTime("01:30", new Date(2026, 2, 29, 10, 0))!;
    expect([at.getDate(), at.getHours(), at.getMinutes()]).toEqual([30, 1, 30]);
  });

  it("rejects malformed times", async () => {
    const { cmd } = await loadCmd();
    const now = new Date();
    for (const t of ["24:00", "12:60", "2am", "", "12"]) {
      expect(cmd.nextLocalTime(t, now)).toBeNull();
    }
  });
});

describe("splitEverySpec", () => {
  it("accepts quoted specs, incl. phone smart quotes", async () => {
    const { cmd } = await loadCmd();
    for (const q of ['"0 2 * * 1-5"', "'0 2 * * 1-5'", "“0 2 * * 1-5”"]) {
      expect(cmd.splitEverySpec(`${q} repo 5 -pr`)).toEqual({
        spec: "0 2 * * 1-5",
        remainder: "repo 5 -pr",
      });
    }
  });

  it("accepts a bare 5-field spec", async () => {
    const { cmd } = await loadCmd();
    expect(cmd.splitEverySpec("0 2 * * * repo")).toEqual({
      spec: "0 2 * * *",
      remainder: "repo",
    });
  });

  it("errors when the repo path is missing", async () => {
    const { cmd } = await loadCmd();
    expect(cmd.splitEverySpec("0 2 * * *")).toHaveProperty("error");
  });
});

describe("scheduling", () => {
  function gitRepo(): string {
    const repo = join(testDir, "repo");
    Bun.spawnSync(["git", "init", "-q", repo]);
    return repo;
  }

  it("/ralph at stores a local one-shot with a resolved repo", async () => {
    const { cmd } = await loadCmd();
    const repo = gitRepo();
    await cmd.handleRalph(mkCtx(`/ralph at 02:00 ${repo} 3 -pr`));
    expect(sends.at(-1)?.content).toContain("scheduled");
    const jobs = await (await import("../cron/store")).getJobs();
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.kind).toBe("ralph");
    expect(job.runAt).toBeDefined();
    const at = new Date(job.runAt!);
    expect([at.getHours(), at.getMinutes()]).toEqual([2, 0]);
    expect(job.ralph).toMatchObject({ iterations: 3, prMode: true });
  });

  it("/ralph every stores a recurring local job", async () => {
    const { cmd } = await loadCmd();
    const repo = gitRepo();
    await cmd.handleRalph(mkCtx(`/ralph every "0 2 * * 1-5" ${repo}`));
    const jobs = await (await import("../cron/store")).getJobs();
    expect(jobs[0]).toMatchObject({
      kind: "ralph",
      schedule: "0 2 * * 1-5",
      tz: "local",
    });
    expect(jobs[0]!.runAt).toBeUndefined();
  });

  it("rejects a bad spec, bad time, or non-repo path at schedule time", async () => {
    const { cmd } = await loadCmd();
    await cmd.handleRalph(mkCtx(`/ralph every "99 2 * * *" ${testDir}`));
    expect(sends.at(-1)?.content).toContain("Invalid spec");
    await cmd.handleRalph(mkCtx(`/ralph at 2am ${testDir}`));
    expect(sends.at(-1)?.content).toContain("need a time");
    await cmd.handleRalph(mkCtx(`/ralph at 02:00 ${testDir}`));
    expect(sends.at(-1)?.content).toContain("not a git repo");
    expect(await (await import("../cron/store")).getJobs()).toHaveLength(0);
  });

  it("/ralph jobs lists only ralph jobs; unsched removes one", async () => {
    const { cmd } = await loadCmd();
    const cron = await import("../cron/store");
    await cron.addJob({
      id: "p1",
      schedule: "0 9 * * *",
      sessionName: "proj",
      prompt: "standup",
      enabled: true,
    });
    const repo = gitRepo();
    await cmd.handleRalph(mkCtx(`/ralph at 02:00 ${repo}`));
    const id = (await cron.getJobs()).find((j) => j.kind === "ralph")!.id;

    await cmd.handleRalph(mkCtx("/ralph jobs"));
    expect(sends.at(-1)?.content).toContain(id);
    expect(sends.at(-1)?.content).not.toContain("p1");

    await cmd.handleRalph(mkCtx("/ralph unsched p1"));
    expect(sends.at(-1)?.content).toContain("No scheduled run");
    await cmd.handleRalph(mkCtx(`/ralph unsched ${id}`));
    expect(sends.at(-1)?.content).toContain("Unscheduled");
    expect((await cron.getJobs()).map((j) => j.id)).toEqual(["p1"]);
  });
});

describe("/cron vs ralph schedules", () => {
  it("/cron del and off refuse ralph ids; list hides them", async () => {
    const { cmd } = await loadCmd();
    const cron = await import("../cron/store");
    const repo = join(testDir, "repo");
    Bun.spawnSync(["git", "init", "-q", repo]);
    await cmd.handleRalph(mkCtx(`/ralph at 02:00 ${repo}`));
    const id = (await cron.getJobs())[0]!.id;
    const { handleCron } = await import("../handlers/commands/cron");

    await handleCron(mkCtx(`/cron del ${id}`));
    expect(sends.at(-1)?.content).toContain("/ralph unsched");
    await handleCron(mkCtx(`/cron off ${id}`));
    expect(sends.at(-1)?.content).toContain("/ralph unsched");
    expect(await cron.getJobs()).toHaveLength(1);
    expect((await cron.getJobs())[0]!.enabled).toBe(true);

    await handleCron(mkCtx("/cron list"));
    expect(sends.at(-1)?.content).toContain("No cron jobs");
  });
});
