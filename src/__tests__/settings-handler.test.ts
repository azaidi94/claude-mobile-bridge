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

// Minimal session mock so renderSettingsBody() can read the model display name.
mock.module("../session", () => ({
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
  getCurrentModel: () => "opus",
  getCurrentModelDisplayName: () => "Opus 4.6",
  setCurrentModel: mock(() => {}),
  runQueryStreaming: mock(async () => "Test response"),
  runPlanApproval: mock(async () => "Plan response"),
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
    // All nine fields should be marked (default).
    const defaultMatches = body.match(/<i>\(default\)<\/i>/g) ?? [];
    expect(defaultMatches.length).toBe(9);
  });

  test("drops (default) marker on fields with overrides", async () => {
    const { saveSetting } = await import("../settings");
    await saveSetting({ terminal: "iterm2", autoWatchOnSpawn: false });
    const { renderSettingsBody } = await import("../handlers/settings");
    const body = renderSettingsBody();
    expect(body).toContain("iTerm2");
    expect(body).toContain("<code>off</code>");
    // Terminal + autowatch now explicit; the other seven fields still default = 7.
    const defaultMatches = body.match(/<i>\(default\)<\/i>/g) ?? [];
    expect(defaultMatches.length).toBe(7);
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
  test("has nine edit buttons in 5-row layout", async () => {
    const { renderSettingsKeyboard } = await import("../handlers/settings");
    const kb = renderSettingsKeyboard();
    expect(kb.inline_keyboard.length).toBe(5);
    expect(kb.inline_keyboard[0]!.length).toBe(2);
    expect(kb.inline_keyboard[1]!.length).toBe(2);
    expect(kb.inline_keyboard[2]!.length).toBe(2);
    expect(kb.inline_keyboard[3]!.length).toBe(2);
    expect(kb.inline_keyboard[4]!.length).toBe(1);
    const all = kb.inline_keyboard.flat();
    expect(all.map((b) => b.callback_data)).toEqual([
      "set:edit:terminal",
      "set:edit:workdir",
      "set:edit:autowatch",
      "set:edit:model",
      "set:edit:pinnedstatus",
      "set:edit:images",
      "set:edit:ralphverbose",
      "set:edit:ralphlabel",
      "set:edit:contextnotify",
    ]);
  });
});

describe("context notify cycle", () => {
  test("cycles off → 10 → 25 → 50 → off on repeated taps", async () => {
    const { handleSettingsCallback } = await import("../handlers/callback");
    const { getContextNotifyStep, _reloadForTests } =
      await import("../settings");
    _reloadForTests();

    const makeCtx = () =>
      ({
        editMessageText: async () => {},
        answerCallbackQuery: async () => {},
      }) as any;

    await handleSettingsCallback(makeCtx(), 1, "set:edit:contextnotify");
    expect(getContextNotifyStep()).toBe(10);

    await handleSettingsCallback(makeCtx(), 1, "set:edit:contextnotify");
    expect(getContextNotifyStep()).toBe(25);

    await handleSettingsCallback(makeCtx(), 1, "set:edit:contextnotify");
    expect(getContextNotifyStep()).toBe(50);

    await handleSettingsCallback(makeCtx(), 1, "set:edit:contextnotify");
    expect(getContextNotifyStep()).toBe(0);
  });

  test("reset clears the override", async () => {
    const { handleSettingsCallback } = await import("../handlers/callback");
    const { getContextNotifyStep, saveSetting, _reloadForTests } =
      await import("../settings");
    _reloadForTests();

    await saveSetting({ contextNotifyStep: 25 });
    expect(getContextNotifyStep()).toBe(25);

    const ctx = {
      editMessageText: async () => {},
      answerCallbackQuery: async () => {},
    } as any;
    await handleSettingsCallback(ctx, 1, "set:reset:contextnotify");
    expect(getContextNotifyStep()).toBe(0);
  });
});

describe("context notify row", () => {
  test("renderSettingsBody shows 'off' when unset", async () => {
    const { renderSettingsBody } = await import("../handlers/settings");
    const body = renderSettingsBody();
    expect(body).toContain("Context notify");
    expect(body).toContain("off");
  });

  test("renderSettingsBody shows 'every 25%' when set to 25", async () => {
    const { saveSetting } = await import("../settings");
    await saveSetting({ contextNotifyStep: 25 });
    const { renderSettingsBody } = await import("../handlers/settings");
    const body = renderSettingsBody();
    expect(body).toContain("every 25%");
  });

  test("renderSettingsKeyboard exposes set:edit:contextnotify button", async () => {
    const { renderSettingsKeyboard } = await import("../handlers/settings");
    const kb = renderSettingsKeyboard();
    const flat = kb.inline_keyboard.flat();
    expect(flat.some((b) => b.callback_data === "set:edit:contextnotify")).toBe(
      true,
    );
  });
});
