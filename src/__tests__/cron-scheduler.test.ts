// Non-UTC host so local-time assertions can't pass by coincidence on UTC CI.
process.env.TZ = "America/New_York";
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "test-token";
process.env.TELEGRAM_ALLOWED_USERS =
  process.env.TELEGRAM_ALLOWED_USERS || "12345";

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";

let testDir: string;
const busCalls: Array<{ threadId?: number; content: string }> = [];
const relayCalls: Array<{ text: string }> = [];
let relayAvailable = true;

// getSession is mocked per-test via sessionsByPid; scheduler.ts only pulls
// `getSession` out of "../sessions", so this narrow mock is safe.
const sessionsByName = new Map<string, { pid?: number }>();
mock.module("../sessions", () => ({
  getSession: (n: string) => sessionsByName.get(n) ?? null,
}));

mock.module("../messaging", () => ({
  getMessageBus: () => ({
    send: async (opts: { threadId?: number; content: string }) => {
      busCalls.push(opts);
      return { messageId: 1 };
    },
  }),
}));

// Ralph launch seams — fireRalphJob dynamic-imports both. Narrow mocks are
// safe only while nothing in scheduler.ts's STATIC import graph loads these
// modules; if that changes, spread the real module in.
const ralphStarts: Array<{ path: string; chatId?: number }> = [];
let activeLoop: { repoPath: string } | null = null;
let startImpl: (
  reply: (html: string) => Promise<unknown>,
) => Promise<boolean> = async () => true;
mock.module("../handlers/commands/ralph", () => ({
  startRalphLoop: async (
    _api: unknown,
    args: { path: string },
    target: { chatId?: number; reply: (html: string) => Promise<unknown> },
  ) => {
    ralphStarts.push({ path: args.path, chatId: target.chatId });
    return startImpl(target.reply);
  },
}));
mock.module("../ralph/store", () => ({
  getActiveLoop: async () => activeLoop,
}));

mock.module("../relay/discovery", () => ({
  getRelayClient: async () =>
    relayAvailable
      ? {
          sendMessage: (m: { text: string }) => {
            relayCalls.push(m);
            return true;
          },
        }
      : null,
}));

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), "cron-sched-"));
  process.env.CRON_STORE_PATH = join(testDir, "cron.json");
  process.env.CLAUDE_TELEGRAM_TOPICS_FILE = join(testDir, "topics.json");
  busCalls.length = 0;
  relayCalls.length = 0;
  relayAvailable = true;
  ralphStarts.length = 0;
  activeLoop = null;
  startImpl = async () => true;
  sessionsByName.clear();

  const { clearTopicStore, addTopicMapping } =
    await import("../topics/topic-store");
  clearTopicStore();
  addTopicMapping({
    sessionName: "proj",
    topicId: 42,
    sessionDir: "/tmp/proj",
    isOnline: true,
    createdAt: new Date().toISOString(),
  });
});

afterEach(async () => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.CRON_STORE_PATH;
  delete process.env.CLAUDE_TELEGRAM_TOPICS_FILE;
  const { clearTopicStore } = await import("../topics/topic-store");
  clearTopicStore();
  const { setCurrentSnapshot } = await import("../sessions/resolve-session");
  setCurrentSnapshot({ aliveRelays: [], topics: [] });
});

async function freshStore() {
  const m = await import("../cron/store");
  m._resetCronStoreForTesting();
  return m;
}

describe("cron scheduler tick", () => {
  it("fires a matching job once and not again on re-entry", async () => {
    const store = await freshStore();
    await store.addJob({
      schedule: "0 9 * * *",
      sessionName: "proj",
      prompt: "morning standup",
      enabled: true,
    });
    const { tick } = await import("../cron/scheduler");
    const when = new Date("2026-05-31T09:00:00.000Z");
    const fakeApi = {} as import("grammy").Api;

    await tick(fakeApi, -100, when);
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0]?.text).toBe("morning standup");
    expect(busCalls[0]?.threadId).toBe(42);

    // Re-entry at the same boundary should be a no-op
    await tick(fakeApi, -100, when);
    expect(relayCalls).toHaveLength(1);
    expect(busCalls).toHaveLength(1);
  });

  it("skips disabled jobs", async () => {
    const store = await freshStore();
    await store.addJob({
      schedule: "* * * * *",
      sessionName: "proj",
      prompt: "x",
      enabled: false,
    });
    const { tick } = await import("../cron/scheduler");
    await tick(
      {} as import("grammy").Api,
      -100,
      new Date("2026-05-31T09:00:00Z"),
    );
    expect(relayCalls).toHaveLength(0);
    expect(busCalls).toHaveLength(0);
  });

  it("posts a header even when relay is unavailable", async () => {
    const store = await freshStore();
    await store.addJob({
      schedule: "* * * * *",
      sessionName: "proj",
      prompt: "x",
      enabled: true,
    });
    relayAvailable = false;
    const { tick } = await import("../cron/scheduler");
    await tick(
      {} as import("grammy").Api,
      -100,
      new Date("2026-05-31T09:00:00Z"),
    );
    expect(relayCalls).toHaveLength(0);
    expect(busCalls).toHaveLength(1);
    expect(busCalls[0]?.content).toContain("session offline");
  });

  it("skips a job with an invalid schedule string", async () => {
    const store = await freshStore();
    await store.addJob({
      schedule: "not a cron",
      sessionName: "proj",
      prompt: "x",
      enabled: true,
    });
    const { tick } = await import("../cron/scheduler");
    await tick(
      {} as import("grammy").Api,
      -100,
      new Date("2026-05-31T09:00:00Z"),
    );
    expect(relayCalls).toHaveLength(0);
    expect(busCalls).toHaveLength(0);
  });

  it("escapes HTML in schedule and prompt headers", async () => {
    const store = await freshStore();
    await store.addJob({
      schedule: "* * * * *",
      sessionName: "proj",
      prompt: "<script>alert(1)</script>",
      enabled: true,
    });
    const { tick } = await import("../cron/scheduler");
    await tick(
      {} as import("grammy").Api,
      -100,
      new Date("2026-05-31T00:00:00Z"),
    );
    expect(busCalls).toHaveLength(1);
    const content = busCalls[0]?.content ?? "";
    expect(content).not.toContain("<script>");
    expect(content).toContain("&lt;script&gt;");
    expect(content).toContain("&lt;/script&gt;");
  });

  it("resolves the topic via launchUuid when the session is live, even if the name maps elsewhere", async () => {
    const store = await freshStore();
    await store.addJob({
      schedule: "* * * * *",
      sessionName: "proj",
      prompt: "x",
      enabled: true,
    });

    const { addTopicMapping } = await import("../topics/topic-store");
    // A different topic claims launchUuid "U1" under a different session
    // name — a name-only lookup for "proj" would land on topicId 42
    // (seeded in beforeEach) instead.
    addTopicMapping({
      sessionName: "other",
      topicId: 77,
      sessionDir: "/tmp/other",
      isOnline: true,
      createdAt: new Date().toISOString(),
      launchUuid: "U1",
    });

    const PID = 4242;
    sessionsByName.set("proj", { pid: PID });
    const { setCurrentSnapshot } = await import("../sessions/resolve-session");
    setCurrentSnapshot({
      aliveRelays: [],
      topics: [],
      launchUuidByPid: new Map([[PID, "U1"]]),
    });

    const { tick } = await import("../cron/scheduler");
    await tick(
      {} as import("grammy").Api,
      -100,
      new Date("2026-05-31T09:00:00Z"),
    );
    expect(busCalls).toHaveLength(1);
    expect(busCalls[0]?.threadId).toBe(77);
  });
});

describe("evaluateMissedMinutes", () => {
  it("ticks each missed minute up to the cap", async () => {
    const store = await freshStore();
    await store.addJob({
      schedule: "* * * * *", // every minute
      sessionName: "proj",
      prompt: "ping",
      enabled: true,
    });
    const { evaluateMissedMinutes } = await import("../cron/scheduler");
    const fakeApi = {} as import("grammy").Api;

    // Gap of 3 minutes: last=0, now=3
    const result = await evaluateMissedMinutes(fakeApi, -100, 3, 0);
    expect(result).toBe(3);
    // Should have fired 3 times (once for minute 1, 2, 3)
    expect(relayCalls).toHaveLength(3);
    expect(busCalls).toHaveLength(3);
  });

  it("caps catch-up at 5 and returns current minute", async () => {
    const store = await freshStore();
    await store.addJob({
      schedule: "* * * * *",
      sessionName: "proj",
      prompt: "ping",
      enabled: true,
    });
    const { evaluateMissedMinutes } = await import("../cron/scheduler");
    const fakeApi = {} as import("grammy").Api;

    // Large gap (simulated sleep): last=0, now=20
    const result = await evaluateMissedMinutes(fakeApi, -100, 20, 0);
    expect(result).toBe(20);
    // Capped at 5 fires (most recent minutes 16-20), not 20
    expect(relayCalls).toHaveLength(5);
    expect(busCalls).toHaveLength(5);
  });
});

describe("evaluateMissedMinutes window", () => {
  it("replays the most recent minutes after a long gap, not the oldest", async () => {
    const store = await freshStore();
    // Epoch minute 20 = 00:20Z; minute 3 = 00:03Z.
    await store.addJob({
      schedule: "20 * * * *",
      sessionName: "proj",
      prompt: "late",
      enabled: true,
    });
    await store.addJob({
      schedule: "3 * * * *",
      sessionName: "proj",
      prompt: "early",
      enabled: true,
    });
    const { evaluateMissedMinutes } = await import("../cron/scheduler");
    await evaluateMissedMinutes({} as any, -100, 20, 0);
    expect(relayCalls.map((c) => c.text)).toEqual(["late"]);
  });
});

const RALPH = { path: "/tmp/repo", iterations: 5, prMode: false };

function ralphJob(over: Record<string, unknown> = {}) {
  return {
    kind: "ralph" as const,
    ralph: RALPH,
    tz: "local" as const,
    schedule: "0 2 * * *",
    sessionName: "",
    prompt: "",
    enabled: true,
    ...over,
  };
}

describe("ralph jobs", () => {
  it("starts a loop on a recurring local-time match", async () => {
    const store = await freshStore();
    const when = new Date(2026, 4, 31, 2, 0); // local 02:00
    await store.addJob({
      kind: "ralph",
      ralph: RALPH,
      tz: "local",
      schedule: "0 2 * * *",
      sessionName: "",
      prompt: "",
      enabled: true,
    });
    const { tick } = await import("../cron/scheduler");
    await tick({} as any, 777, when);
    expect(ralphStarts).toEqual([{ path: "/tmp/repo", chatId: 777 }]);
    expect(relayCalls).toHaveLength(0);
    // Recurring jobs stay in the store.
    expect(await store.getJobs()).toHaveLength(1);
  });

  it("skips (not queues) when a loop is already running", async () => {
    const store = await freshStore();
    activeLoop = { repoPath: "/tmp/busy" };
    await store.addJob({
      kind: "ralph",
      ralph: RALPH,
      tz: "local",
      schedule: "* * * * *",
      sessionName: "",
      prompt: "",
      enabled: true,
    });
    const { tick } = await import("../cron/scheduler");
    await tick({} as any, 777, new Date());
    expect(ralphStarts).toHaveLength(0);
    expect(busCalls.at(-1)?.content).toContain("skipped");
    expect(busCalls.at(-1)?.content).toContain("/tmp/busy");
  });

  it("one-shot fires once when due, then is removed", async () => {
    const store = await freshStore();
    const due = new Date("2026-05-31T02:00:00.000Z");
    await store.addJob({
      kind: "ralph",
      ralph: RALPH,
      runAt: due.toISOString(),
      schedule: "",
      sessionName: "",
      prompt: "",
      enabled: true,
    });
    const { tick } = await import("../cron/scheduler");
    await tick({} as any, 777, new Date(due.getTime() - 60_000));
    expect(ralphStarts).toHaveLength(0);
    await tick({} as any, 777, due);
    expect(ralphStarts).toHaveLength(1);
    expect(await store.getJobs()).toHaveLength(0);
    await tick({} as any, 777, new Date(due.getTime() + 60_000));
    expect(ralphStarts).toHaveLength(1);
  });

  it("one-shot fires late within the grace window (bot restart)", async () => {
    const store = await freshStore();
    const due = new Date("2026-05-31T02:00:00.000Z");
    await store.addJob({
      kind: "ralph",
      ralph: RALPH,
      runAt: due.toISOString(),
      schedule: "",
      sessionName: "",
      prompt: "",
      enabled: true,
    });
    const { tick } = await import("../cron/scheduler");
    await tick({} as any, 777, new Date(due.getTime() + 20 * 60_000));
    expect(ralphStarts).toHaveLength(1);
  });

  it("drops a one-shot found past the grace window with a notice", async () => {
    const store = await freshStore();
    const due = new Date("2026-05-31T02:00:00.000Z");
    await store.addJob({
      kind: "ralph",
      ralph: RALPH,
      runAt: due.toISOString(),
      schedule: "",
      sessionName: "",
      prompt: "",
      enabled: true,
    });
    const { tick } = await import("../cron/scheduler");
    await tick({} as any, 777, new Date(due.getTime() + 3 * 3_600_000));
    expect(ralphStarts).toHaveLength(0);
    expect(busCalls.at(-1)?.content).toContain("missed");
    expect(await store.getJobs()).toHaveLength(0);
  });
});

describe("ralph jobs — edge cases", () => {
  it("UTC prompt jobs don't fire at local-time matches", async () => {
    const store = await freshStore();
    await store.addJob({
      schedule: "0 2 * * *",
      sessionName: "proj",
      prompt: "utc",
      enabled: true,
    });
    const { tick } = await import("../cron/scheduler");
    await tick({} as any, 777, new Date(2026, 4, 31, 2, 0)); // local 02:00 = 06:00Z
    expect(relayCalls).toHaveLength(0);
  });

  it("does not re-fire when the same minute is ticked twice", async () => {
    const store = await freshStore();
    await store.addJob(ralphJob());
    const { tick } = await import("../cron/scheduler");
    const when = new Date(2026, 4, 31, 2, 0);
    await tick({} as any, 777, when);
    await tick({} as any, 777, when);
    expect(ralphStarts).toHaveLength(1);
  });

  it("fires once across the DST fall-back repeat of the same local minute", async () => {
    const store = await freshStore();
    await store.addJob(ralphJob({ schedule: "30 1 * * *" }));
    const { tick } = await import("../cron/scheduler");
    // 2026-11-01 America/New_York: 01:30 EDT = 05:30Z, then 01:30 EST = 06:30Z.
    await tick({} as any, 777, new Date("2026-11-01T05:30:00Z"));
    await tick({} as any, 777, new Date("2026-11-01T06:30:00Z"));
    expect(ralphStarts).toHaveLength(1);
    // Next day still fires.
    await tick({} as any, 777, new Date("2026-11-02T06:30:00Z"));
    expect(ralphStarts).toHaveLength(2);
  });

  it("second job in the same minute is skipped while the first is starting", async () => {
    const store = await freshStore();
    let release!: (ok: boolean) => void;
    startImpl = () => new Promise<boolean>((r) => (release = r));
    await store.addJob(ralphJob({ id: "a" }));
    await store.addJob(ralphJob({ id: "b" }));
    const { tick } = await import("../cron/scheduler");
    await tick({} as any, 777, new Date(2026, 4, 31, 2, 0));
    expect(ralphStarts).toHaveLength(1);
    expect(busCalls.at(-1)?.content).toContain("another scheduled loop");
    release(true);
  });

  it("posts start progress to General and reports a thrown start", async () => {
    const store = await freshStore();
    startImpl = async (reply) => {
      await reply("launching");
      throw new Error("boom");
    };
    await store.addJob(ralphJob());
    const { tick } = await import("../cron/scheduler");
    await tick({} as any, 777, new Date(2026, 4, 31, 2, 0));
    await Bun.sleep(0);
    const launch = busCalls.find((c) => c.content.includes("launching"));
    expect(launch?.threadId).toBeUndefined();
    expect(busCalls.at(-1)?.content).toContain("scheduled start failed");
    expect(busCalls.at(-1)?.content).toContain("boom");
  });
});
