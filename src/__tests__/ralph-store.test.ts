import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, rmSync, existsSync, mkdirSync, symlinkSync } from "fs";
import { join } from "path";

let testDir: string;
let storePath: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ralph-test-"));
  storePath = join(testDir, "ralph.json");
  process.env.RALPH_STORE_PATH = storePath;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.RALPH_STORE_PATH;
});

async function freshModule() {
  const m = await import("../ralph/store");
  m._resetRalphStoreForTesting();
  return m;
}

function baseLoop(over: Record<string, unknown> = {}) {
  return {
    id: "abc",
    repoPath: "/tmp/repo",
    iterations: 10,
    prMode: false,
    runDir: join(testDir, "run-abc"),
    tailOffset: 0,
    verbose: false,
    startedAt: "2026-07-05T00:00:00.000Z",
    ...over,
  };
}

describe("ralph store", () => {
  it("returns empty when no file exists", async () => {
    const m = await freshModule();
    expect(await m.getLoops()).toEqual([]);
    expect(await m.getActiveLoop()).toBeNull();
    expect(m.getActiveLoopSync()).toBeNull();
  });

  it("addLoop persists and marks active", async () => {
    const m = await freshModule();
    const res = await m.addLoop(baseLoop());
    expect(res.ok).toBe(true);
    expect(await m.getLoops()).toHaveLength(1);
    expect((await m.getActiveLoop())?.id).toBe("abc");
    // sync cache coherent immediately after mutation
    expect(m.getActiveLoopSync()?.id).toBe("abc");
  });

  it("addLoop rejects when an active loop exists", async () => {
    const m = await freshModule();
    await m.addLoop(baseLoop({ id: "one" }));
    const res = await m.addLoop(baseLoop({ id: "two" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("active loop");
    expect(await m.getLoops()).toHaveLength(1);
  });

  it("prunes previous non-active record + its runDir on add", async () => {
    const m = await freshModule();
    const oldRunDir = join(testDir, "run-old");
    mkdirSync(oldRunDir, { recursive: true });
    await m.addLoop(baseLoop({ id: "old", runDir: oldRunDir }));
    // end it so it's no longer active
    await m.updateLoop("old", { state: "ended" });
    expect(m.getActiveLoopSync()).toBeNull();

    const res = await m.addLoop(baseLoop({ id: "new" }));
    expect(res.ok).toBe(true);
    const loops = await m.getLoops();
    expect(loops).toHaveLength(1);
    expect(loops[0]?.id).toBe("new");
    expect(existsSync(oldRunDir)).toBe(false); // rm -rf'd
  });

  it("updateLoop mutates and keeps sync cache coherent", async () => {
    const m = await freshModule();
    await m.addLoop(baseLoop());
    await m.updateLoop("abc", { pid: 4242, state: "running" });
    expect(m.getActiveLoopSync()?.pid).toBe(4242);
    // transition to completed → no longer active
    await m.updateLoop("abc", { state: "completed" });
    expect(m.getActiveLoopSync()).toBeNull();
    expect(await m.getActiveLoop()).toBeNull();
  });

  it("removeLoop deletes by id", async () => {
    const m = await freshModule();
    await m.addLoop(baseLoop());
    expect(await m.removeLoop("abc")).toBe(true);
    expect(await m.getLoops()).toHaveLength(0);
    expect(m.getActiveLoopSync()).toBeNull();
    expect(await m.removeLoop("nope")).toBe(false);
  });

  it("rejects the loser of two concurrent addLoop calls (TOCTOU)", async () => {
    const m = await freshModule();
    // A leftover non-active record forces the prune path (its awaits are
    // where the historical race window lived).
    const oldRunDir = join(testDir, "run-stale");
    mkdirSync(oldRunDir, { recursive: true });
    await m.addLoop(baseLoop({ id: "stale", runDir: oldRunDir }));
    await m.updateLoop("stale", { state: "ended" });

    const [a, b] = await Promise.all([
      m.addLoop(baseLoop({ id: "racer-a" })),
      m.addLoop(baseLoop({ id: "racer-b" })),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loops = await m.getLoops();
    expect(loops.filter((l) => l.state === "starting")).toHaveLength(1);
  });

  it("isRalphLoopTopic requires BOTH chat and thread to match", async () => {
    const m = await freshModule();
    await m.addLoop(baseLoop({ chatId: 100, topicId: 7 }));
    expect(m.isRalphLoopTopic(100, 7)).toBe(true);
    expect(m.isRalphLoopTopic(200, 7)).toBe(false); // same topic id, other chat
    expect(m.isRalphLoopTopic(100, 8)).toBe(false);
    expect(m.isRalphLoopTopic(undefined, undefined)).toBe(false);
    await m.updateLoop("abc", { state: "ended" });
    expect(m.isRalphLoopTopic(100, 7)).toBe(false); // no active loop
  });

  it("isRalphOwnedDir matches the active loop's repo, else false", async () => {
    const m = await freshModule();
    expect(m.isRalphOwnedDir("/tmp/repo")).toBe(false); // no active loop
    await m.addLoop(baseLoop({ repoPath: "/tmp/repo" }));
    expect(m.isRalphOwnedDir("/tmp/repo")).toBe(true);
    expect(m.isRalphOwnedDir("/tmp/other")).toBe(false);
    await m.updateLoop("abc", { state: "ended" });
    expect(m.isRalphOwnedDir("/tmp/repo")).toBe(false); // loop no longer active
  });

  it("isRalphOwnedDir resolves symlinked dirs to the same repo", async () => {
    const m = await freshModule();
    // Real repo dir + a symlink pointing at it — a watch's sessionDir may be
    // either form, so both must be recognized as owned.
    const repo = join(testDir, "real-repo");
    const link = join(testDir, "link-repo");
    mkdirSync(repo);
    symlinkSync(repo, link);
    await m.addLoop(baseLoop({ repoPath: repo }));
    expect(m.isRalphOwnedDir(link)).toBe(true);
  });

  it("ralphBlocksTopicWatch: owned dir blocks non-beat topics, exempts the beat topic", async () => {
    const m = await freshModule();
    // No active loop → never blocks.
    expect(m.ralphBlocksTopicWatch("/tmp/repo", 5, 9)).toBe(false);
    await m.addLoop(baseLoop({ repoPath: "/tmp/repo", chatId: 5, topicId: 9 }));
    // Owned dir + some unrelated session topic → blocked.
    expect(m.ralphBlocksTopicWatch("/tmp/repo", 5, 42)).toBe(true);
    // Owned dir + the loop's OWN beat topic → exempt.
    expect(m.ralphBlocksTopicWatch("/tmp/repo", 5, 9)).toBe(false);
    // Different dir → not owned, never blocked.
    expect(m.ralphBlocksTopicWatch("/tmp/other", 5, 42)).toBe(false);
  });

  it("writes a JSON file on flush", async () => {
    const m = await freshModule();
    await m.addLoop(baseLoop({ id: "persisted" }));
    await m.flush();
    expect(existsSync(storePath)).toBe(true);
    const data = JSON.parse(await Bun.file(storePath).text());
    expect(data.loops?.[0]?.id).toBe("persisted");
  });
});
