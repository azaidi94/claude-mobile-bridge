import "./ensure-test-env";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let TMP: string;
let LOG: string;

beforeEach(async () => {
  TMP = mkdtempSync(join(tmpdir(), "log-rotation-"));
  LOG = join(TMP, "bot.log");
  const { _resetForTests } = await import("../log-rotation");
  _resetForTests();
});

afterEach(() => {
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
    await new Promise((r) => setTimeout(r, 20));
    expect(_currentBytesForTests()).toBeGreaterThan(0);
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
    await new Promise((r) => setTimeout(r, 20));
    _forceRotateForTests();
    expect(existsSync(`${LOG}.1`)).toBe(true);
    writeToBotLog("after rotate\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(statSync(`${LOG}.1`).size).toBeGreaterThan(0);
  });
});
