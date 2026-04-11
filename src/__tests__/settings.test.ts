/**
 * Unit tests for src/settings.ts.
 *
 * Each test points the settings module at a fresh temp file via
 * CLAUDE_MOBILE_BRIDGE_SETTINGS_FILE and calls `_reloadForTests()` to reset
 * the in-memory cache.
 *
 * NOTE: CLAUDE_WORKING_DIR and DESKTOP_TERMINAL_APP must be set BEFORE the
 * first import of `../config` (which freezes them into module-level consts).
 * We set them at top-of-file, before any import, so the first transitive
 * load of config.ts through settings.ts sees the test values.
 */

// Bootstrap env — must run before any `import` of ../settings/../config.
process.env.CLAUDE_WORKING_DIR = "/tmp/test-env-workdir";
process.env.DESKTOP_TERMINAL_APP = "iTerm2";
// Required by config.ts validation (avoids process.exit on load).
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "test-token";
process.env.TELEGRAM_ALLOWED_USERS =
  process.env.TELEGRAM_ALLOWED_USERS || "12345";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmpDir: string;
let settingsPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "settings-test-"));
  settingsPath = join(tmpDir, "settings.json");
  process.env.CLAUDE_MOBILE_BRIDGE_SETTINGS_FILE = settingsPath;
  const { _reloadForTests } = await import("../settings");
  _reloadForTests();
});

afterEach(async () => {
  delete process.env.CLAUDE_MOBILE_BRIDGE_SETTINGS_FILE;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("settings getters (no file)", () => {
  test("getWorkingDir falls back to env", async () => {
    const { getWorkingDir } = await import("../settings");
    expect(getWorkingDir()).toBe("/tmp/test-env-workdir");
  });

  test("getTerminal falls back to env (parsed)", async () => {
    const { getTerminal } = await import("../settings");
    expect(getTerminal()).toBe("iterm2");
  });

  test("getAutoWatchOnSpawn defaults to true", async () => {
    const { getAutoWatchOnSpawn } = await import("../settings");
    expect(getAutoWatchOnSpawn()).toBe(true);
  });

  test("getDefaultModelSetting returns undefined when unset", async () => {
    const { getDefaultModelSetting } = await import("../settings");
    expect(getDefaultModelSetting()).toBeUndefined();
  });
});

describe("saveSetting", () => {
  test("writes a file that subsequent reads pick up", async () => {
    const { saveSetting, getWorkingDir, _reloadForTests } =
      await import("../settings");
    await saveSetting({ workingDir: "/tmp/override" });
    expect(getWorkingDir()).toBe("/tmp/override");
    // Round-trip: nuke cache, re-load from disk.
    _reloadForTests();
    expect(getWorkingDir()).toBe("/tmp/override");
  });

  test("merges patches without clobbering other fields", async () => {
    const { saveSetting, getOverrides } = await import("../settings");
    await saveSetting({ terminal: "ghostty" });
    await saveSetting({ autoWatchOnSpawn: false });
    const o = getOverrides();
    expect(o.terminal).toBe("ghostty");
    expect(o.autoWatchOnSpawn).toBe(false);
  });

  test("undefined clears the override (reset)", async () => {
    const { saveSetting, getOverrides, getAutoWatchOnSpawn } =
      await import("../settings");
    await saveSetting({ autoWatchOnSpawn: false });
    expect(getAutoWatchOnSpawn()).toBe(false);
    await saveSetting({ autoWatchOnSpawn: undefined });
    expect(getOverrides().autoWatchOnSpawn).toBeUndefined();
    expect(getAutoWatchOnSpawn()).toBe(true); // back to default
  });

  test("creates parent directory if missing", async () => {
    const nested = join(tmpDir, "deep", "settings.json");
    process.env.CLAUDE_MOBILE_BRIDGE_SETTINGS_FILE = nested;
    const { _reloadForTests, saveSetting } = await import("../settings");
    _reloadForTests();
    await saveSetting({ terminal: "cmux" });
    expect(existsSync(nested)).toBe(true);
  });
});

describe("model persistence round-trip", () => {
  test("saveSetting defaultModel + reload restores value", async () => {
    const { saveSetting, getDefaultModelSetting, _reloadForTests } =
      await import("../settings");
    await saveSetting({ defaultModel: "sonnet" });
    expect(getDefaultModelSetting()).toBe("sonnet");
    _reloadForTests();
    expect(getDefaultModelSetting()).toBe("sonnet");
  });
});

describe("loadSync sanitization", () => {
  test("ignores invalid JSON, returns defaults", async () => {
    await writeFile(settingsPath, "{ this is not json");
    const { _reloadForTests, getOverrides } = await import("../settings");
    _reloadForTests();
    expect(getOverrides()).toEqual({});
  });

  test("ignores fields with wrong types", async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({
        terminal: 42,
        workingDir: ["not", "a", "string"],
        autoWatchOnSpawn: "yes",
        defaultModel: null,
      }),
    );
    const { _reloadForTests, getOverrides } = await import("../settings");
    _reloadForTests();
    expect(getOverrides()).toEqual({});
  });

  test("coerces known terminal aliases via parseTerminalApp", async () => {
    await writeFile(settingsPath, JSON.stringify({ terminal: "iTerm" }));
    const { _reloadForTests, getTerminal } = await import("../settings");
    _reloadForTests();
    expect(getTerminal()).toBe("iterm2");
  });
});
