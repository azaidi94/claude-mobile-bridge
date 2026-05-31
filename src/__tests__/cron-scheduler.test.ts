import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";

let testDir: string;
const busCalls: Array<{ threadId?: number; content: string }> = [];
const relayCalls: Array<{ text: string }> = [];
let relayAvailable = true;

mock.module("../topics", () => ({
  getTopicBySession: (n: string) =>
    n === "proj" ? { topicId: 42, sessionDir: "/tmp/proj" } : undefined,
}));

mock.module("../messaging", () => ({
  getMessageBus: () => ({
    send: async (opts: { threadId?: number; content: string }) => {
      busCalls.push(opts);
      return { messageId: 1 };
    },
  }),
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

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "cron-sched-"));
  process.env.CRON_STORE_PATH = join(testDir, "cron.json");
  busCalls.length = 0;
  relayCalls.length = 0;
  relayAvailable = true;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.CRON_STORE_PATH;
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
});
