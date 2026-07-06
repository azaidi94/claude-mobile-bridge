import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const sends: { content: string; replyMarkup?: unknown }[] = [];
let nextMessageId = 1;
mock.module("../messaging", () => ({
  getMessageBus: () => ({
    send: async (m: { content: string; replyMarkup?: unknown }) => {
      sends.push(m);
      return { messageId: nextMessageId++ };
    },
    edit: async () => ({}),
  }),
  setMessageBus: () => {},
  createMessageBus: () => ({}),
}));

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ralph-rec-"));
  process.env.RALPH_STORE_PATH = join(testDir, "ralph.json");
  sends.length = 0;
  nextMessageId = 1;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.RALPH_STORE_PATH;
});

/** A pid that has exited → process.kill(pid, 0) throws ESRCH (definitely dead). */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"]);
  const pid = proc.pid;
  await proc.exited;
  return pid;
}

describe("recoverRalphOnBoot", () => {
  it("finalizes a dead loop as complete from a terminal marker past the offset", async () => {
    const store = await import("../ralph/store");
    store._resetRalphStoreForTesting();
    const monitor = await import("../ralph/monitor");

    const runDir = join(testDir, "run");
    mkdirSync(runDir, { recursive: true });
    // Log contains an iteration then the COMPLETE marker, all beyond offset 0.
    writeFileSync(
      join(runDir, "run.log"),
      "=== Iteration 3/10 ===\nAll issues resolved after 3 iterations.\n",
    );

    await store.addLoop({
      id: "rec1",
      repoPath: runDir, // gh runs here and fails silently
      iterations: 10,
      prMode: false,
      runDir,
      tailOffset: 0,
      verbose: false,
      chatId: 789,
      topicId: 5,
      pid: await deadPid(),
      state: "running",
      startedAt: "2026-07-05T00:00:00.000Z",
    });

    const pins: number[] = [];
    const unpins: number[] = [];
    const fakeApi = {
      pinChatMessage: async (_c: number, id: number) => {
        pins.push(id);
      },
      unpinChatMessage: async (_c: number, id: number) => {
        unpins.push(id);
      },
    } as any;
    await monitor.recoverRalphOnBoot(fakeApi);

    // No longer active; finalized as completed via the marker.
    expect(await store.getActiveLoop()).toBeNull();
    const loop = (await store.getLoops())[0]!;
    expect(loop.state).toBe("completed");
    expect(loop.endReason).toBe("complete");

    // Offline-prefixed final beat mentioning COMPLETE was posted.
    const beat = sends.map((s) => s.content).join("\n");
    expect(beat).toContain("offline");
    expect(beat).toContain("COMPLETE");

    // A wrap-up summary block was posted above the button.
    expect(beat).toContain("Loop summary");
    expect(beat).toContain("ran for");
    expect(beat).toContain("3/10 iterations");

    // Natural completion → a delete-topic button rides the summary message.
    const markup = JSON.stringify(sends.map((s) => s.replyMarkup));
    expect(markup).toContain("ralph:deltopic:rec1");
    expect(markup).toContain("Delete topic");

    // The summary block was pinned as the topic's final marker. (Recovery
    // finalizes straight from the log tail, so no earlier beat was pinned here.)
    expect(pins.length).toBe(1);
    expect(unpins).toEqual([]);
    expect(loop.pinnedMessageId).toBe(pins[0]);
  });

  it("does not offer delete-topic when the loop process just died", async () => {
    const store = await import("../ralph/store");
    store._resetRalphStoreForTesting();
    const monitor = await import("../ralph/monitor");

    const runDir = join(testDir, "run2");
    mkdirSync(runDir, { recursive: true });
    // No terminal marker — the pid is simply gone → "process-died", not natural.
    writeFileSync(join(runDir, "run.log"), "=== Iteration 1/10 ===\n");

    await store.addLoop({
      id: "rec2",
      repoPath: runDir,
      iterations: 10,
      prMode: false,
      runDir,
      tailOffset: 0,
      verbose: false,
      chatId: 789,
      topicId: 7,
      pid: await deadPid(),
      state: "running",
      startedAt: "2026-07-05T00:00:00.000Z",
    });

    await monitor.recoverRalphOnBoot({} as any);

    const loop = (await store.getLoops())[0]!;
    expect(loop.endReason).toBe("process-died");
    const markup = JSON.stringify(sends.map((s) => s.replyMarkup));
    expect(markup).not.toContain("deltopic");
  });
});
