// Set STATE_DIR before any module-load happens — paths.ts evaluates the env
// var at import time.
import { join } from "path";
import { tmpdir } from "os";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
} from "fs";

const TEST_STATE_DIR = mkdtempSync(join(tmpdir(), "bf-state-"));
process.env.CLAUDE_TELEGRAM_STATE_DIR = TEST_STATE_DIR;

import { describe, expect, test, beforeEach, afterAll } from "bun:test";
// Use dynamic import so it happens *after* the env-var assignment above —
// static imports are hoisted and would otherwise load paths.ts before
// CLAUDE_TELEGRAM_STATE_DIR is set.
const { backfillPortFileSessionIds } = await import("../relay/backfill");
const { claudeProjectDir } = await import("../paths");

// Underscores in the path are the regression: Claude encodes them as dashes,
// so the on-disk project dir is `-tmp---backfill-test-proj--`, NOT the
// slash-only `-tmp-__backfill_test_proj__` the old encoder produced.
const PROJECT_CWD = "/tmp/__backfill_test_proj__";
const PROJECT_DIR = claudeProjectDir(PROJECT_CWD);

function clearDir(dir: string) {
  try {
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
  } catch {}
}

beforeEach(() => {
  clearDir(TEST_STATE_DIR);
  try {
    rmSync(PROJECT_DIR, { recursive: true, force: true });
  } catch {}
  mkdirSync(PROJECT_DIR, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(TEST_STATE_DIR, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(PROJECT_DIR, { recursive: true, force: true });
  } catch {}
});

function writePortFile(name: string, data: Record<string, unknown>) {
  writeFileSync(join(TEST_STATE_DIR, name), JSON.stringify(data, null, 2));
}

function readPortFile(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(TEST_STATE_DIR, name), "utf-8"));
}

const NOW = Date.now();

describe("backfillPortFileSessionIds", () => {
  test("backfills sessionId when a single matching JSONL exists", async () => {
    writePortFile(`channel-relay-aaaa-${process.pid}.json`, {
      port: 1234,
      pid: process.pid,
      cwd: PROJECT_CWD,
      startedAt: new Date(NOW - 60_000).toISOString(),
    });
    const sid = "11111111-2222-3333-4444-555555555555";
    writeFileSync(join(PROJECT_DIR, `${sid}.jsonl`), "x\n");

    await backfillPortFileSessionIds();
    const after = readPortFile(`channel-relay-aaaa-${process.pid}.json`);
    expect(after.sessionId).toBe(sid);
  });

  test("does not overwrite an existing sessionId", async () => {
    const existing = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    writePortFile(`channel-relay-bbbb-${process.pid}.json`, {
      port: 1234,
      pid: process.pid,
      cwd: PROJECT_CWD,
      startedAt: new Date(NOW - 60_000).toISOString(),
      sessionId: existing,
    });
    const other = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    writeFileSync(join(PROJECT_DIR, `${other}.jsonl`), "x\n");

    await backfillPortFileSessionIds();
    const after = readPortFile(`channel-relay-bbbb-${process.pid}.json`);
    expect(after.sessionId).toBe(existing);
  });

  test("skips port files for dead processes", async () => {
    writePortFile("channel-relay-cccc-999999.json", {
      port: 1234,
      pid: 999999, // very unlikely to be alive
      cwd: PROJECT_CWD,
      startedAt: new Date(NOW - 60_000).toISOString(),
    });
    const sid = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    writeFileSync(join(PROJECT_DIR, `${sid}.jsonl`), "x\n");

    await backfillPortFileSessionIds();
    const after = readPortFile("channel-relay-cccc-999999.json");
    expect(after.sessionId).toBeUndefined();
  });

  test("does not double-claim a JSONL already taken by another port file", async () => {
    // updatePortFile finds a port file by matching the pid in its filename.
    // For the second file we need a real but unique-in-filename pid; use
    // process.pid for the to-be-checked one, and a sibling pid for the
    // already-claimed one (its sessionId is pre-populated so no update is
    // attempted on it).
    const sid = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    writePortFile(`channel-relay-dddd-${process.pid + 1}.json`, {
      port: 1234,
      pid: process.pid + 1,
      cwd: PROJECT_CWD,
      startedAt: new Date(NOW - 60_000).toISOString(),
      sessionId: sid,
    });
    writePortFile(`channel-relay-eeee-${process.pid}.json`, {
      port: 1235,
      pid: process.pid,
      cwd: PROJECT_CWD,
      startedAt: new Date(NOW - 60_000).toISOString(),
    });
    writeFileSync(join(PROJECT_DIR, `${sid}.jsonl`), "x\n");

    await backfillPortFileSessionIds();
    const after = readPortFile(`channel-relay-eeee-${process.pid}.json`);
    expect(after.sessionId).toBeUndefined();
  });

  // Never guess across siblings: two id-less LIVE relays in one cwd must get
  // NEITHER backfilled. Writing a mtime-guessed id into a sibling's port file
  // (persisted, authoritative-looking) is the misroute bug — worse than the
  // in-memory guess. Exact pid routing handles siblings; the hook / relay
  // self-discovery supply their real ids.
  test("does not backfill ambiguous same-cwd siblings", async () => {
    const a = process.pid;
    const b = process.ppid; // also a live process
    writePortFile(`channel-relay-siba-${a}.json`, {
      port: 1,
      pid: a,
      cwd: PROJECT_CWD,
      startedAt: new Date(NOW - 60_000).toISOString(),
    });
    writePortFile(`channel-relay-sibb-${b}.json`, {
      port: 2,
      pid: b,
      cwd: PROJECT_CWD,
      startedAt: new Date(NOW - 60_000).toISOString(),
    });
    writeFileSync(
      join(PROJECT_DIR, "11111111-1111-1111-1111-111111111111.jsonl"),
      "x\n",
    );
    writeFileSync(
      join(PROJECT_DIR, "22222222-2222-2222-2222-222222222222.jsonl"),
      "x\n",
    );

    await backfillPortFileSessionIds();

    expect(
      readPortFile(`channel-relay-siba-${a}.json`).sessionId,
    ).toBeUndefined();
    expect(
      readPortFile(`channel-relay-sibb-${b}.json`).sessionId,
    ).toBeUndefined();
  });
});
