import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

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
  testDir = mkdtempSync(join(tmpdir(), "ralph-rec-"));
  process.env.RALPH_STORE_PATH = join(testDir, "ralph.json");
  sends.length = 0;
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

    const fakeApi = {} as any;
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
  });
});
