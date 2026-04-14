/**
 * Smoke tests for /settings panel rendering.
 *
 * These hit the real settings module (pointed at a temp file) to verify
 * the full render pipeline and edit → rerender loop.
 */

// Bootstrap env — must run before any `import` of ../config/../settings.
process.env.CLAUDE_WORKING_DIR = "/tmp/test-env";
process.env.DESKTOP_TERMINAL_APP = "Terminal";
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "test-token";
process.env.TELEGRAM_ALLOWED_USERS =
  process.env.TELEGRAM_ALLOWED_USERS || "12345";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "settings-handler-test-"));
  process.env.CLAUDE_MOBILE_BRIDGE_SETTINGS_FILE = join(
    tmpDir,
    "settings.json",
  );
  const { _reloadForTests } = await import("../settings");
  _reloadForTests();
});

afterEach(async () => {
  delete process.env.CLAUDE_MOBILE_BRIDGE_SETTINGS_FILE;
  await rm(tmpDir, { recursive: true, force: true });
});

// Minimal session mock so renderSettingsBody() can read modelDisplayName.
mock.module("../session", () => ({
  session: {
    model: "opus",
    modelDisplayName: "Opus 4.6",
    setModel: mock(() => {}),
  },
  MODEL_DISPLAY_NAMES: {
    opus: "Opus 4.6",
    sonnet: "Sonnet 4.6",
    haiku: "Haiku 4.5",
  },
  getModelDisplayName: (m: string) => {
    const map: Record<string, string> = {
      opus: "Opus 4.6",
      sonnet: "Sonnet 4.6",
      haiku: "Haiku 4.5",
    };
    return map[m] ?? m;
  },
}));

describe("renderSettingsBody", () => {
  test("shows (default) markers when nothing is overridden", async () => {
    const { renderSettingsBody } = await import("../handlers/settings");
    const body = renderSettingsBody();
    expect(body).toContain("⚙️ <b>Settings</b>");
    expect(body).toContain("━ Spawning (/new) ━");
    expect(body).toContain("━ Claude defaults ━");
    expect(body).toContain("Terminal.app");
    expect(body).toContain("Opus 4.6");
    // All six fields should be marked (default).
    const defaultMatches = body.match(/<i>\(default\)<\/i>/g) ?? [];
    expect(defaultMatches.length).toBe(6);
  });

  test("drops (default) marker on fields with overrides", async () => {
    const { saveSetting } = await import("../settings");
    await saveSetting({ terminal: "iterm2", autoWatchOnSpawn: false });
    const { renderSettingsBody } = await import("../handlers/settings");
    const body = renderSettingsBody();
    expect(body).toContain("iTerm2");
    expect(body).toContain("<code>off</code>");
    // Terminal + autowatch now explicit; workdir + model + topics + pinnedStatus still default = 4.
    const defaultMatches = body.match(/<i>\(default\)<\/i>/g) ?? [];
    expect(defaultMatches.length).toBe(4);
  });

  test("truncates long working dirs with leading ellipsis", async () => {
    const { saveSetting } = await import("../settings");
    const longPath =
      "/Users/someone/very/long/nested/project/directory/here/ok";
    await saveSetting({ workingDir: longPath });
    const { renderSettingsBody } = await import("../handlers/settings");
    const body = renderSettingsBody();
    // Either ~-prefixed (if HOME matches) or …-prefixed when >30 chars.
    expect(body).toMatch(/(~|…)/);
    // The absolute-path prefix shouldn't appear in the rendered body.
    expect(body).not.toContain(longPath);
  });
});

describe("renderSettingsKeyboard", () => {
  test("has six edit buttons in 3x2 layout", async () => {
    const { renderSettingsKeyboard } = await import("../handlers/settings");
    const kb = renderSettingsKeyboard();
    expect(kb.inline_keyboard.length).toBe(3);
    expect(kb.inline_keyboard[0]!.length).toBe(2);
    expect(kb.inline_keyboard[1]!.length).toBe(2);
    expect(kb.inline_keyboard[2]!.length).toBe(2);
    const all = kb.inline_keyboard.flat();
    expect(all.map((b) => b.callback_data)).toEqual([
      "set:edit:terminal",
      "set:edit:workdir",
      "set:edit:autowatch",
      "set:edit:model",
      "set:edit:topics",
      "set:edit:pinnedstatus",
    ]);
  });
});
