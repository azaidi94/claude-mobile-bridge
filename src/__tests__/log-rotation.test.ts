import "./ensure-test-env";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let TMP: string;
let LOG: string;

/**
 * Poll until `check()` is true (or timeout). Writes go through an async
 * WriteStream, so the bytes land on disk a tick or more after the
 * synchronous `writeToBotLog` call returns. A fixed `sleep(20)` races that
 * flush on a loaded CI runner (issue #55); polling waits exactly as long as
 * the flush actually takes and no longer — deterministic, not timing-based.
 */
async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  TMP = mkdtempSync(join(tmpdir(), "log-rotation-"));
  LOG = join(TMP, "bot.log");
  const { _resetForTests } = await import("../log-rotation");
  _resetForTests();
});

afterEach(async () => {
  // Close the active stream BEFORE deleting its directory. Otherwise the
  // stream lingers open against a path we then rmSync, and its late async
  // open/flush errors out — see the openStream 'error' handler for why that
  // used to fail a random unrelated test on loaded CI.
  const { _resetForTests } = await import("../log-rotation");
  _resetForTests();
  rmSync(TMP, { recursive: true, force: true });
});

describe("log rotation", () => {
  test("setupBotLogRotation creates the directory and an empty bot.log", async () => {
    const { setupBotLogRotation } = await import("../log-rotation");
    setupBotLogRotation(LOG);
    expect(existsSync(LOG)).toBe(true);
    expect(statSync(LOG).size).toBe(0);
  });

  test("setupBotLogRotation rotates existing non-empty bot.log to .1", async () => {
    writeFileSync(LOG, "old content\n");
    const { setupBotLogRotation } = await import("../log-rotation");
    setupBotLogRotation(LOG);
    expect(existsSync(`${LOG}.1`)).toBe(true);
    expect(existsSync(LOG)).toBe(true);
    expect(statSync(LOG).size).toBe(0);
  });

  test("setupBotLogRotation leaves an empty bot.log alone (no rotate)", async () => {
    writeFileSync(LOG, "");
    const { setupBotLogRotation } = await import("../log-rotation");
    setupBotLogRotation(LOG);
    expect(existsSync(`${LOG}.1`)).toBe(false);
  });

  test("writeToBotLog appends to bot.log", async () => {
    const { setupBotLogRotation, writeToBotLog, _currentBytesForTests } =
      await import("../log-rotation");
    setupBotLogRotation(LOG);
    writeToBotLog("hello\n");
    writeToBotLog("world\n");
    // Byte counter is updated synchronously; the on-disk flush is async.
    expect(_currentBytesForTests()).toBeGreaterThan(0);
    await waitFor(() => statSync(LOG).size > 0);
    expect(statSync(LOG).size).toBeGreaterThan(0);
  });

  test("rotation cascades archives (bot.log.1 → bot.log.2)", async () => {
    writeFileSync(LOG, "gen0\n");
    const { setupBotLogRotation } = await import("../log-rotation");
    setupBotLogRotation(LOG);
    writeFileSync(LOG, "gen1\n");
    setupBotLogRotation(LOG);
    expect(existsSync(`${LOG}.1`)).toBe(true);
    expect(existsSync(`${LOG}.2`)).toBe(true);
  });

  test("rotation drops the oldest beyond MAX_ARCHIVES (5)", async () => {
    const { setupBotLogRotation } = await import("../log-rotation");
    for (let i = 0; i < 6; i++) {
      writeFileSync(LOG, `gen${i}\n`);
      setupBotLogRotation(LOG);
    }
    expect(existsSync(`${LOG}.1`)).toBe(true);
    expect(existsSync(`${LOG}.5`)).toBe(true);
    expect(existsSync(`${LOG}.6`)).toBe(false);
  });

  test("_forceRotateForTests rotates the current file mid-stream", async () => {
    const { setupBotLogRotation, writeToBotLog, _forceRotateForTests } =
      await import("../log-rotation");
    setupBotLogRotation(LOG);
    writeToBotLog("before rotate\n");
    // Wait until "before rotate" is actually on disk, THEN rotate — so the
    // rename moves a non-empty bot.log to bot.log.1. Rotating before the
    // flush lands was the race behind the intermittent CI failure.
    await waitFor(() => existsSync(LOG) && statSync(LOG).size > 0);
    _forceRotateForTests();
    expect(existsSync(`${LOG}.1`)).toBe(true);
    expect(statSync(`${LOG}.1`).size).toBeGreaterThan(0);
    writeToBotLog("after rotate\n");
  });
});
