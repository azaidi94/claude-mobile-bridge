import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getRecents,
  recordUse,
  flush,
  _resetSkillRecentsForTesting,
} from "../skills/recents";

let storePath: string;
let prev: string | undefined;

beforeEach(() => {
  storePath = join(
    tmpdir(),
    `skill-recents-${Math.random().toString(36).slice(2)}.json`,
  );
  prev = process.env.SKILL_RECENTS_STORE_PATH;
  process.env.SKILL_RECENTS_STORE_PATH = storePath;
  _resetSkillRecentsForTesting();
});

afterEach(() => {
  if (prev === undefined) delete process.env.SKILL_RECENTS_STORE_PATH;
  else process.env.SKILL_RECENTS_STORE_PATH = prev;
  rmSync(storePath, { force: true });
});

test("most-recent first, no duplicates", async () => {
  await recordUse("tdd");
  await recordUse("research");
  await recordUse("tdd"); // re-use moves to front, dedups
  expect(await getRecents()).toEqual(["tdd", "research"]);
});

test("caps at 12 entries", async () => {
  for (let i = 0; i < 20; i++) await recordUse(`skill-${i}`);
  const recents = await getRecents();
  expect(recents).toHaveLength(12);
  expect(recents[0]).toBe("skill-19"); // newest
});

test("persists across a reload (flush -> reset -> read)", async () => {
  await recordUse("alpha");
  await recordUse("beta");
  await flush();

  // Simulate a bot restart: drop in-memory state, reload from disk.
  _resetSkillRecentsForTesting();
  expect(await getRecents()).toEqual(["beta", "alpha"]);

  // File is real JSON on disk.
  const onDisk = JSON.parse(readFileSync(storePath, "utf-8"));
  expect(onDisk.recents).toEqual(["beta", "alpha"]);
});
