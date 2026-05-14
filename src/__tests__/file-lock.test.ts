import "./ensure-test-env";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, stat, utimes } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { withFileLock } from "../topics/file-lock";

let dir = "";
let target = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "file-lock-test-"));
  target = join(dir, "data.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("withFileLock", () => {
  test("serialises concurrent critical sections", async () => {
    const events: string[] = [];
    const section = (id: string) =>
      withFileLock(target, async () => {
        events.push(`${id}:enter`);
        await new Promise((r) => setTimeout(r, 30));
        events.push(`${id}:exit`);
      });

    await Promise.all([section("A"), section("B"), section("C")]);

    // No interleaving: every enter is immediately followed by its own exit.
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i]!.split(":")[0]).toBe(events[i + 1]!.split(":")[0]);
    }
    expect(events).toHaveLength(6);
  });

  test("releases the lock after the callback resolves", async () => {
    await withFileLock(target, async () => {});
    // A second acquisition must succeed promptly.
    let ran = false;
    await withFileLock(target, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("releases the lock even when the callback throws", async () => {
    await expect(
      withFileLock(target, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Lock must be free for the next caller.
    let ran = false;
    await withFileLock(target, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("steals a stale lock left by a crashed holder", async () => {
    const lockPath = `${target}.lock`;
    await writeFile(lockPath, "");
    // Age the lock well past the staleness threshold.
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    let ran = false;
    await withFileLock(target, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    // And the lock is released afterwards.
    await expect(stat(lockPath)).rejects.toThrow();
  });
});
