# Settings Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/settings` — a persistent, Telegram-UI settings panel covering terminal app, working dir, auto-watch-on-spawn, and default model. Values survive bot restarts.

**Architecture:** New `src/settings.ts` owns a JSON-backed cache at `~/.claude-mobile-bridge/settings.json` and exposes read-through getters (`getWorkingDir()`, `getTerminal()`, `getAutoWatchOnSpawn()`) that consult the settings file first, fall back to env/hardcoded. Writes go through `saveSetting(patch)`. New `src/handlers/settings.ts` renders the panel (inline keyboard) and routes edit callbacks. `session.setModel()` gains a one-liner that persists to the same file — killing the previous "model isn't persisted at all" gap. Existing consumers of `WORKING_DIR`/`DESKTOP_TERMINAL_APP` consts are moved to the getters.

**Tech Stack:** Bun, TypeScript, grammY

---

## File Map

| File                             | Action     | Responsibility                                                                                              |
| -------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| `src/settings.ts`                | **Create** | JSON cache + getters + `saveSetting()`                                                                      |
| `src/__tests__/settings.test.ts` | **Create** | Unit tests for load/save/precedence                                                                         |
| `src/handlers/settings.ts`       | **Create** | `/settings` handler, panel render, callback router, pending-reply map                                       |
| `src/handlers/commands.ts`       | **Modify** | Swap `WORKING_DIR`/`DESKTOP_TERMINAL_APP` → getters; gate `startWatchingSession` on spawn                   |
| `src/handlers/callback.ts`       | **Modify** | Route `set:*` callbacks through `handleSettingsCallback`                                                    |
| `src/handlers/text.ts`           | **Modify** | Check `pendingSettingsInput` before other pending-reply branches                                            |
| `src/handlers/index.ts`          | **Modify** | Re-export `handleSettings`                                                                                  |
| `src/session.ts`                 | **Modify** | `setModel` persists to settings; startup resolves via `getDefaultModelSetting()`; swap `WORKING_DIR` import |
| `src/index.ts`                   | **Modify** | Startup log uses `getWorkingDir()`                                                                          |
| `src/bot.ts`                     | **Modify** | Register `bot.command("settings", handleSettings)`                                                          |
| `src/__tests__/commands.test.ts` | **Modify** | Mock `../settings` module to prevent real-FS writes during tests                                            |

---

## Task 1: `src/settings.ts` — settings module

**Files:**

- Create: `src/settings.ts`
- Create: `src/__tests__/settings.test.ts`

- [ ] **Step 1.1: Write failing unit tests**

Create `src/__tests__/settings.test.ts`:

```typescript
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
```

- [ ] **Step 1.2: Run tests, verify they fail**

Run: `bun run test src/__tests__/settings.test.ts`
Expected: FAIL with "Cannot find module '../settings'"

- [ ] **Step 1.3: Create the settings module**

Create `src/settings.ts`:

```typescript
/**
 * Persistent user-settings cache for Claude Mobile Bridge.
 *
 * Read-through getters consult the in-memory cache (seeded from disk on
 * first read) and fall back to env-bootstrap values from config.ts. Writes
 * go through saveSetting(), which merges into the cache and persists the
 * whole object to `~/.claude-mobile-bridge/settings.json`.
 *
 * Precedence: settings file → env var → hardcoded default.
 *
 * Test hook: CLAUDE_MOBILE_BRIDGE_SETTINGS_FILE overrides the path, and
 * _reloadForTests() nukes the cache so tests can point at temp files.
 */

import { homedir } from "os";
import { dirname, join } from "path";
import { mkdir } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import {
  WORKING_DIR as ENV_WORKING_DIR,
  DESKTOP_TERMINAL_APP as ENV_TERMINAL_APP,
  parseTerminalApp,
  type TerminalApp,
} from "./config";
import { debug, warn } from "./logger";

export interface BridgeSettings {
  terminal?: TerminalApp;
  workingDir?: string;
  autoWatchOnSpawn?: boolean;
  defaultModel?: string;
}

function resolveSettingsPath(): string {
  return (
    process.env.CLAUDE_MOBILE_BRIDGE_SETTINGS_FILE ??
    join(homedir(), ".claude-mobile-bridge", "settings.json")
  );
}

let cache: BridgeSettings | null = null;

function sanitize(raw: unknown): BridgeSettings {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const out: BridgeSettings = {};
  if (typeof o.terminal === "string") {
    out.terminal = parseTerminalApp(o.terminal);
  }
  if (typeof o.workingDir === "string") {
    out.workingDir = o.workingDir;
  }
  if (typeof o.autoWatchOnSpawn === "boolean") {
    out.autoWatchOnSpawn = o.autoWatchOnSpawn;
  }
  if (typeof o.defaultModel === "string") {
    out.defaultModel = o.defaultModel;
  }
  return out;
}

function loadSync(): BridgeSettings {
  const path = resolveSettingsPath();
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return sanitize(parsed);
  } catch (err) {
    warn(`settings: load failed (${path}): ${err}`);
    return {};
  }
}

function ensure(): BridgeSettings {
  if (cache === null) cache = loadSync();
  return cache;
}

/**
 * Reset the in-memory cache. Tests only.
 */
export function _reloadForTests(): void {
  cache = null;
}

export async function saveSetting(
  patch: Partial<BridgeSettings>,
): Promise<void> {
  const c = ensure();
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) {
      delete (c as Record<string, unknown>)[k];
    } else {
      (c as Record<string, unknown>)[k] = v;
    }
  }
  try {
    const path = resolveSettingsPath();
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, JSON.stringify(c, null, 2));
    debug(`settings: saved ${Object.keys(patch).join(",")}`);
  } catch (err) {
    warn(`settings: save failed: ${err}`);
  }
}

export function getTerminal(): TerminalApp {
  return ensure().terminal ?? ENV_TERMINAL_APP;
}

export function getWorkingDir(): string {
  return ensure().workingDir ?? ENV_WORKING_DIR;
}

export function getAutoWatchOnSpawn(): boolean {
  return ensure().autoWatchOnSpawn ?? true;
}

export function getDefaultModelSetting(): string | undefined {
  return ensure().defaultModel;
}

/**
 * Snapshot of currently-overridden fields. Used by the UI to show "(default)"
 * markers and decide whether "Reset" is meaningful.
 */
export function getOverrides(): BridgeSettings {
  return { ...ensure() };
}
```

- [ ] **Step 1.4: Run tests, verify they pass**

Run: `bun run test src/__tests__/settings.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 1.5: Commit**

```bash
git add src/settings.ts src/__tests__/settings.test.ts
git commit -m "feat: settings module — persistent JSON-backed user settings

New src/settings.ts with read-through getters for terminal, working dir,
auto-watch, and default model. File lives at ~/.claude-mobile-bridge/
settings.json (NOT /tmp). Precedence: settings file → env → hardcoded.
Saves merge-patch and support undefined = reset to default."
```

---

## Task 2: Plumb getters through call sites

**Files:**

- Modify: `src/handlers/commands.ts`
- Modify: `src/session.ts`
- Modify: `src/index.ts`
- Modify: `src/__tests__/commands.test.ts`

- [ ] **Step 2.1: Swap imports in `commands.ts`**

In `src/handlers/commands.ts`, change the config import at lines 13-23 from:

```typescript
import {
  WORKING_DIR,
  ALLOWED_USERS,
  RESTART_FILE,
  findClaudeCli,
  isDesktopClaudeSpawnSupported,
  DESKTOP_CLAUDE_DEFAULT_ARGS,
  DESKTOP_CLAUDE_COMMAND_TEMPLATE,
  DESKTOP_TERMINAL_APP,
  type TerminalApp,
} from "../config";
```

to:

```typescript
import {
  ALLOWED_USERS,
  RESTART_FILE,
  findClaudeCli,
  isDesktopClaudeSpawnSupported,
  DESKTOP_CLAUDE_DEFAULT_ARGS,
  DESKTOP_CLAUDE_COMMAND_TEMPLATE,
  type TerminalApp,
} from "../config";
import { getWorkingDir, getTerminal, getAutoWatchOnSpawn } from "../settings";
```

- [ ] **Step 2.2: Replace `WORKING_DIR` usages in `commands.ts`**

Six call sites: 586, 817, 1185, 1218, 1267, 1268. Replace every bare `WORKING_DIR` identifier with `getWorkingDir()`. Grep to confirm zero remaining:

Run: use Grep tool, pattern `\bWORKING_DIR\b`, path `src/handlers/commands.ts`
Expected: zero matches.

- [ ] **Step 2.3: Replace `DESKTOP_TERMINAL_APP` in `commands.ts`**

Line 226 in `openMacOSTerminalWithCommand`:

```typescript
const built = buildTerminalSpawnArgs(getTerminal(), shellCommand, explicitPath);
```

Grep to confirm zero `DESKTOP_TERMINAL_APP` remaining in this file.

- [ ] **Step 2.4: Swap `WORKING_DIR` in `session.ts`**

In `src/session.ts`, change the config import (line 26) to remove `WORKING_DIR`, and add:

```typescript
import { getWorkingDir } from "./settings";
```

Replace line 190 and line 802 usages:

```typescript
// line 190
private _workingDir: string = getWorkingDir();

// line 802
this._workingDir = getWorkingDir();
```

- [ ] **Step 2.5: Swap `WORKING_DIR` in `index.ts`**

Line 47 is a startup log. Change:

```typescript
import { getWorkingDir } from "./settings";
// ...
`cwd: ${getWorkingDir()} (${ALLOWED_USERS.length} user${ALLOWED_USERS.length !== 1 ? "s" : ""})`;
```

And remove `WORKING_DIR` from the `./config` import on line 10.

- [ ] **Step 2.6: Mock `../settings` in `commands.test.ts`**

Existing handlers now import from `../settings`. Without a mock, tests will load the real module which touches `~/.claude-mobile-bridge/settings.json`. Add the mock near the other `mock.module` calls in `src/__tests__/commands.test.ts`:

```typescript
mock.module("../settings", () => ({
  getWorkingDir: () => "/tmp/test-working-dir",
  getTerminal: () => "terminal" as const,
  getAutoWatchOnSpawn: () => true,
  getDefaultModelSetting: () => undefined,
  getOverrides: () => ({}),
  saveSetting: mock(() => Promise.resolve()),
  _reloadForTests: mock(() => {}),
}));
```

Also add the same mock.module block to any other test file that imports from `../session`, `../handlers/commands`, or `../handlers/text` — check each file. At minimum:

- `src/__tests__/commands.test.ts`
- `src/__tests__/plan-mode.test.ts`
- `src/__tests__/streaming.test.ts`
- `src/__tests__/ask-user-question.test.ts`
- `src/__tests__/file-download.test.ts`
- `src/__tests__/message-router.test.ts`
- `src/__tests__/watch.test.ts`

Grep the tests dir for `mock.module("../config"` to find them all.

- [ ] **Step 2.7: Typecheck**

Run: `bun run typecheck`
Expected: passes.

- [ ] **Step 2.8: Run tests**

Run: `bun run test`
Expected: all existing tests pass (no regressions).

- [ ] **Step 2.9: Commit**

```bash
git add src/handlers/commands.ts src/session.ts src/index.ts src/__tests__/
git commit -m "refactor: route WORKING_DIR and DESKTOP_TERMINAL_APP through settings getters

Call sites now consult settings.ts (which reads the settings file, then
env, then hardcoded). Existing env exports in config.ts remain as the
bootstrap layer. No behavior change on a fresh install."
```

---

## Task 3: Persist model selection through settings

**Files:**

- Modify: `src/session.ts`

- [ ] **Step 3.1: Write a failing test**

Append to `src/__tests__/settings.test.ts` (inside its own `describe` block):

```typescript
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
```

Run: `bun run test src/__tests__/settings.test.ts`
Expected: PASS (the settings module already supports this — this test locks the contract `session.ts` will rely on).

- [ ] **Step 3.2: Wire `setModel` to persist**

In `src/session.ts`, at the top of the file (near the other settings-adjacent imports), add:

```typescript
import { getDefaultModelSetting, saveSetting } from "./settings";
```

Update `setModel` (around line 222) to persist:

```typescript
setModel(model: ModelId): void {
  this._model = model;
  info(`model: ${model}`);
  saveSetting({ defaultModel: model }).catch(() => {
    // non-fatal; runtime already updated
  });
}
```

- [ ] **Step 3.3: Resolve default model from settings at startup**

Rewrite the `DEFAULT_MODEL` resolver (around line 167-173) to insert settings file as the highest-priority source:

```typescript
const envModel = process.env.CLAUDE_MODEL?.trim() || undefined;
const settingsModel = getDefaultModelSetting();

function pickAcceptableModel(m: string | undefined): ModelId | undefined {
  if (m && isAcceptableModelId(m)) return m as ModelId;
  return undefined;
}

const DEFAULT_MODEL: ModelId =
  pickAcceptableModel(settingsModel) ??
  pickAcceptableModel(envModel) ??
  readClaudeSettingsModel() ??
  "opus";
```

- [ ] **Step 3.4: Typecheck + tests**

Run: `bun run typecheck && bun run test`
Expected: passes.

- [ ] **Step 3.5: Commit**

```bash
git add src/session.ts src/__tests__/settings.test.ts
git commit -m "feat: persist model selection via settings module

setModel now writes {defaultModel} to ~/.claude-mobile-bridge/settings.json
so /model choices survive restarts. Startup resolves DEFAULT_MODEL from
settings file first, then CLAUDE_MODEL env, then ~/.claude/settings.json,
then 'opus'. Replaces the prior gap where /model choices were in-memory
only."
```

---

## Task 4: Gate auto-watch on spawn

**Files:**

- Modify: `src/handlers/commands.ts`

- [ ] **Step 4.1: Wrap `startWatchingSession` call**

In `spawnDesktopClaudeSession` (around line 524), change:

```typescript
startWatchingSession(api, chatId, spawned.name, "spawn").catch(() => {});
```

to:

```typescript
if (getAutoWatchOnSpawn()) {
  startWatchingSession(api, chatId, spawned.name, "spawn").catch(() => {});
}
```

`getAutoWatchOnSpawn` is already imported from Task 2.

- [ ] **Step 4.2: Typecheck + tests**

Run: `bun run typecheck && bun run test`
Expected: passes. Existing spawn tests don't flip the setting so the default-true branch keeps them passing.

- [ ] **Step 4.3: Commit**

```bash
git add src/handlers/commands.ts
git commit -m "feat: gate spawn auto-watch on settings.autoWatchOnSpawn

Default true (unchanged behavior). When user flips off via /settings,
/new and /sessions→Resume leave the new desktop session unwatched;
user taps the 👁 Watch button manually."
```

---

## Task 5: Settings handler — panel render + command registration

**Files:**

- Create: `src/handlers/settings.ts`
- Modify: `src/handlers/index.ts`
- Modify: `src/bot.ts`

- [ ] **Step 5.1: Create the handler file**

Create `src/handlers/settings.ts`:

```typescript
/**
 * /settings command — unified settings panel.
 *
 * Renders one inline-keyboard panel with four edit buttons. Edit flows for
 * enum fields (terminal, model) open sub-keyboards; the text field (working
 * dir) uses a pending-reply pattern handled in text.ts. Auto-watch cycles
 * on→off→default on each tap without a sub-keyboard.
 *
 * Callback routing for `set:*` lives in callback.ts (handleSettingsCallback).
 */

import type { Context } from "grammy";
import { ALLOWED_USERS } from "../config";
import { isAuthorized } from "../security";
import { session } from "../session";
import {
  getTerminal,
  getWorkingDir,
  getAutoWatchOnSpawn,
  getOverrides,
} from "../settings";
import { escapeHtml } from "../formatting";

/**
 * Map of chat IDs awaiting a text reply for a settings field.
 * Consumed by text.ts before its normal routing.
 */
export const pendingSettingsInput = new Map<number, "workdir">();

export const TERMINAL_LABELS: Record<string, string> = {
  terminal: "Terminal.app",
  iterm2: "iTerm2",
  ghostty: "Ghostty",
  cmux: "cmux",
};

function truncPath(p: string, max = 30): string {
  const home = process.env.HOME || "";
  let s = p;
  if (home && s.startsWith(home)) s = "~" + s.slice(home.length);
  if (s.length <= max) return s;
  return "…" + s.slice(-(max - 1));
}

export function renderSettingsBody(): string {
  const terminal = getTerminal();
  const workdir = getWorkingDir();
  const autowatch = getAutoWatchOnSpawn();
  const modelDisplay = session.modelDisplayName;
  const overrides = getOverrides();

  const marker = (k: keyof typeof overrides): string =>
    overrides[k] !== undefined ? "" : " <i>(default)</i>";

  return [
    "⚙️ <b>Settings</b>",
    "",
    "━ Spawning (/new) ━",
    `🖥 Terminal:     <code>${escapeHtml(
      TERMINAL_LABELS[terminal] ?? terminal,
    )}</code>${marker("terminal")}`,
    `📁 Working dir:  <code>${escapeHtml(truncPath(workdir))}</code>${marker(
      "workingDir",
    )}`,
    `👁 Auto-watch:   <code>${autowatch ? "on" : "off"}</code>${marker(
      "autoWatchOnSpawn",
    )}`,
    "",
    "━ Claude defaults ━",
    `🤖 Model:        <code>${escapeHtml(modelDisplay)}</code>${marker(
      "defaultModel",
    )}`,
  ].join("\n");
}

export function renderSettingsKeyboard(): {
  inline_keyboard: { text: string; callback_data: string }[][];
} {
  return {
    inline_keyboard: [
      [
        { text: "🖥 Terminal", callback_data: "set:edit:terminal" },
        { text: "📁 Working dir", callback_data: "set:edit:workdir" },
      ],
      [
        { text: "👁 Auto-watch", callback_data: "set:edit:autowatch" },
        { text: "🤖 Model", callback_data: "set:edit:model" },
      ],
    ],
  };
}

/**
 * /settings — open the panel.
 */
export async function handleSettings(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }
  await ctx.reply(renderSettingsBody(), {
    parse_mode: "HTML",
    reply_markup: renderSettingsKeyboard(),
  });
}

/**
 * Re-render the panel in place (used after edits).
 */
export async function rerenderSettingsPanel(ctx: Context): Promise<void> {
  await ctx
    .editMessageText(renderSettingsBody(), {
      parse_mode: "HTML",
      reply_markup: renderSettingsKeyboard(),
    })
    .catch(() => {
      // Message may be gone; silent.
    });
}
```

- [ ] **Step 5.2: Export from handlers/index.ts**

Add to `src/handlers/index.ts`:

```typescript
export { handleSettings, pendingSettingsInput } from "./settings";
```

- [ ] **Step 5.3: Register `/settings` in bot.ts**

In `src/bot.ts`:

Add `handleSettings` to the import list on line 22-48:

```typescript
  handleSettings,
```

And register the command after line 126 (`bot.command("execute", handleExecute);`):

```typescript
bot.command("settings", handleSettings);
```

- [ ] **Step 5.4: Typecheck**

Run: `bun run typecheck`
Expected: passes.

- [ ] **Step 5.5: Commit**

```bash
git add src/handlers/settings.ts src/handlers/index.ts src/bot.ts
git commit -m "feat: /settings panel — read-only render

Adds the /settings command and panel renderer. Shows current effective
values grouped into Spawning (/new) and Claude defaults sections, with
(default) markers for fields that aren't overridden. Edit buttons route
to set:edit:* callbacks (wired in next commit)."
```

---

## Task 6: Edit callbacks — enum sub-keyboards, auto-watch cycle, reset

**Files:**

- Modify: `src/handlers/callback.ts`

- [ ] **Step 6.1: Add imports**

At the top of `src/handlers/callback.ts`, add:

```typescript
import {
  pendingSettingsInput,
  rerenderSettingsPanel,
  TERMINAL_LABELS,
} from "./settings";
import {
  saveSetting,
  getTerminal,
  getWorkingDir,
  getOverrides,
} from "../settings";
import type { TerminalApp } from "../config";
import { MODEL_DISPLAY_NAMES } from "../session";
```

Also make sure `session` (already imported) and `type ModelId` (already imported) are available.

- [ ] **Step 6.2: Route `set:*` callbacks**

Inside `handleCallback`, insert this block immediately after the `auq:` block's closing brace (the branch that handles AskUserQuestion callbacks, ending around line 575) and **before** the `if (!callbackData.startsWith("askuser:"))` bare-fallback check around line 577. That way `set:*` callbacks don't fall through to the askuser parser:

```typescript
// Settings panel callbacks: set:<action>[:<field>[:<value>]]
if (callbackData.startsWith("set:")) {
  await handleSettingsCallback(ctx, chatId, callbackData);
  return;
}
```

And add this helper function at the bottom of `callback.ts`:

```typescript
async function handleSettingsCallback(
  ctx: Context,
  chatId: number,
  data: string,
): Promise<void> {
  const parts = data.split(":");
  const action = parts[1];

  if (action === "edit") {
    const field = parts[2];
    if (field === "terminal") {
      const current = getTerminal();
      const choices: TerminalApp[] = ["terminal", "iterm2", "ghostty", "cmux"];
      const rows = choices.map((c) => [
        {
          text: c === current ? `✓ ${TERMINAL_LABELS[c]}` : TERMINAL_LABELS[c]!,
          callback_data: `set:pick:terminal:${c}`,
        },
      ]);
      rows.push([
        { text: "↺ Reset to default", callback_data: "set:reset:terminal" },
        { text: "← Back", callback_data: "set:back" },
      ]);
      await ctx.editMessageText("🖥 <b>Select terminal:</b>", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: rows },
      });
      await ctx.answerCallbackQuery();
      return;
    }

    if (field === "workdir") {
      pendingSettingsInput.set(chatId, "workdir");
      await ctx.editMessageText(
        `📁 <b>Reply with absolute path</b> (or <code>/cancel</code>):\n\nCurrent: <code>${escapeHtml(
          getWorkingDir(),
        )}</code>`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "↺ Reset to default",
                  callback_data: "set:reset:workdir",
                },
                { text: "← Cancel", callback_data: "set:back" },
              ],
            ],
          },
        },
      );
      await ctx.answerCallbackQuery({ text: "Reply with new path" });
      return;
    }

    if (field === "autowatch") {
      // Cycle: default(undefined) → off(false) → on(true) → default
      const current = getOverrides().autoWatchOnSpawn;
      let next: boolean | undefined;
      if (current === undefined) next = false;
      else if (current === false) next = true;
      else next = undefined;
      await saveSetting({ autoWatchOnSpawn: next });
      await rerenderSettingsPanel(ctx);
      const label = next === undefined ? "default (on)" : next ? "on" : "off";
      await ctx.answerCallbackQuery({ text: `Auto-watch: ${label}` });
      return;
    }

    if (field === "model") {
      const current = session.model;
      const models = Object.entries(MODEL_DISPLAY_NAMES) as [ModelId, string][];
      const rows = models.map(([id, name]) => [
        {
          text: id === current ? `✓ ${name}` : name,
          callback_data: `set:pick:model:${id}`,
        },
      ]);
      rows.push([
        { text: "↺ Reset to default", callback_data: "set:reset:model" },
        { text: "← Back", callback_data: "set:back" },
      ]);
      await ctx.editMessageText(
        `🤖 <b>Model:</b> ${session.modelDisplayName}`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: rows },
        },
      );
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery({ text: "Unknown field" });
    return;
  }

  if (action === "pick") {
    const field = parts[2];
    const value = parts[3];
    if (!field || !value) {
      await ctx.answerCallbackQuery({ text: "Bad payload" });
      return;
    }
    if (field === "terminal") {
      await saveSetting({ terminal: value as TerminalApp });
      await rerenderSettingsPanel(ctx);
      await ctx.answerCallbackQuery({ text: `Terminal: ${value}` });
      return;
    }
    if (field === "model") {
      // setModel() writes to settings AND updates the running session.
      session.setModel(value as ModelId);
      await rerenderSettingsPanel(ctx);
      await ctx.answerCallbackQuery({ text: `Model: ${value}` });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Unknown field" });
    return;
  }

  if (action === "reset") {
    const field = parts[2];
    if (field === "terminal") {
      await saveSetting({ terminal: undefined });
    } else if (field === "workdir") {
      await saveSetting({ workingDir: undefined });
      pendingSettingsInput.delete(chatId);
    } else if (field === "autowatch") {
      await saveSetting({ autoWatchOnSpawn: undefined });
    } else if (field === "model") {
      // Clearing the override only affects next restart; the live session
      // keeps whatever model it last had.
      await saveSetting({ defaultModel: undefined });
    } else {
      await ctx.answerCallbackQuery({ text: "Unknown field" });
      return;
    }
    await rerenderSettingsPanel(ctx);
    await ctx.answerCallbackQuery({ text: `Reset ${field}` });
    return;
  }

  if (action === "back") {
    pendingSettingsInput.delete(chatId);
    await rerenderSettingsPanel(ctx);
    await ctx.answerCallbackQuery();
    return;
  }

  await ctx.answerCallbackQuery({ text: "Unknown action" });
}
```

- [ ] **Step 6.3: Typecheck**

Run: `bun run typecheck`
Expected: passes.

- [ ] **Step 6.4: Commit**

```bash
git add src/handlers/callback.ts
git commit -m "feat: /settings edit callbacks — enum pickers, cycle, reset

set:edit:terminal and set:edit:model open sub-keyboards with ✓ on the
current value. set:edit:autowatch cycles default→off→on→default in
place. set:edit:workdir arms pendingSettingsInput and swaps to a
'reply with path' prompt. set:reset:<field> clears the override;
set:back re-renders the main panel. set:pick:model routes through
session.setModel so the running session updates too."
```

---

## Task 7: Working dir pending-reply in text.ts

**Files:**

- Modify: `src/handlers/text.ts`

- [ ] **Step 7.1: Add imports**

At the top of `src/handlers/text.ts`, add:

```typescript
import { isAbsolute } from "path";
import { stat } from "fs/promises";
import { pendingSettingsInput, rerenderSettingsPanel } from "./settings";
import { saveSetting } from "../settings";
import { escapeHtml } from "../formatting";
```

- [ ] **Step 7.2: Insert the pending-input branch**

Add this block **immediately after** the `// Pass-through prefix` line (~line 71, right before the `// 1.5. Check for pending plan feedback` block around line 74):

```typescript
// 1.4. Check for pending settings input (working dir entry)
if (pendingSettingsInput.has(chatId)) {
  const field = pendingSettingsInput.get(chatId)!;
  if (message.trim() === "/cancel") {
    pendingSettingsInput.delete(chatId);
    await ctx.reply("✖ Cancelled.");
    return;
  }
  if (field === "workdir") {
    const path = message.trim();
    if (!isAbsolute(path)) {
      await ctx.reply("❌ Path must be absolute (start with /).");
      return;
    }
    try {
      const s = await stat(path);
      if (!s.isDirectory()) {
        await ctx.reply("❌ Not a directory.");
        return;
      }
    } catch {
      await ctx.reply("❌ Path does not exist.");
      return;
    }
    await saveSetting({ workingDir: path });
    pendingSettingsInput.delete(chatId);
    await ctx.reply(`✅ Working dir set:\n<code>${escapeHtml(path)}</code>`, {
      parse_mode: "HTML",
    });
    return;
  }
}
```

- [ ] **Step 7.3: Typecheck + tests**

Run: `bun run typecheck && bun run test`
Expected: passes. Existing text-routing tests aren't affected because `pendingSettingsInput` starts empty.

- [ ] **Step 7.4: Commit**

```bash
git add src/handlers/text.ts
git commit -m "feat: working-dir pending-reply hook in text handler

Checks pendingSettingsInput before normal text routing. Validates the
reply is an absolute, existing directory; on success writes to the
settings file and acks. /cancel aborts."
```

---

## Task 8: End-to-end render smoke test

**Files:**

- Create: `src/__tests__/settings-handler.test.ts`

- [ ] **Step 8.1: Write the render test**

Create `src/__tests__/settings-handler.test.ts`:

```typescript
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
    // All four fields should be marked (default).
    const defaultMatches = body.match(/<i>\(default\)<\/i>/g) ?? [];
    expect(defaultMatches.length).toBe(4);
  });

  test("drops (default) marker on fields with overrides", async () => {
    const { saveSetting } = await import("../settings");
    await saveSetting({ terminal: "iterm2", autoWatchOnSpawn: false });
    const { renderSettingsBody } = await import("../handlers/settings");
    const body = renderSettingsBody();
    expect(body).toContain("iTerm2");
    expect(body).toContain("<code>off</code>");
    // Terminal + autowatch now explicit; workdir + model still default = 2.
    const defaultMatches = body.match(/<i>\(default\)<\/i>/g) ?? [];
    expect(defaultMatches.length).toBe(2);
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
  test("has four edit buttons in 2x2 layout", async () => {
    const { renderSettingsKeyboard } = await import("../handlers/settings");
    const kb = renderSettingsKeyboard();
    expect(kb.inline_keyboard.length).toBe(2);
    expect(kb.inline_keyboard[0]!.length).toBe(2);
    expect(kb.inline_keyboard[1]!.length).toBe(2);
    const all = kb.inline_keyboard.flat();
    expect(all.map((b) => b.callback_data)).toEqual([
      "set:edit:terminal",
      "set:edit:workdir",
      "set:edit:autowatch",
      "set:edit:model",
    ]);
  });
});
```

- [ ] **Step 8.2: Run the new tests**

Run: `bun run test src/__tests__/settings-handler.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 8.3: Run the whole suite**

Run: `bun run test`
Expected: all tests pass.

- [ ] **Step 8.4: Commit**

```bash
git add src/__tests__/settings-handler.test.ts
git commit -m "test: smoke tests for /settings panel rendering

Covers render output (headers, default markers, truncation) and the
2x2 edit keyboard layout with expected callback_data values."
```

---

## Task 9: Manual verification + README note

**Files:**

- Modify: `README.md`

- [ ] **Step 9.1: Run the bot and smoke-test in Telegram**

Run: `bun run dev`

In Telegram, walk through:

1. `/settings` — panel should render with 4 buttons and all fields marked (default).
2. Tap **🖥 Terminal** → pick iTerm2 → panel re-renders, Terminal row shows `iTerm2` without (default).
3. Tap **📁 Working dir** → bot prompts; reply with `/cancel` → dismissed.
4. Tap **📁 Working dir** again → reply with a real absolute path → panel re-renders with new value.
5. Tap **👁 Auto-watch** → toast shows "off"; panel shows `off`. Tap again → "on". Tap again → "default (on)".
6. Tap **🤖 Model** → pick sonnet → panel shows `Sonnet 4.6`.
7. `/model` — confirm it still works and shows the updated current model.
8. Restart the bot (`Ctrl-C` + `bun run dev`).
9. `/settings` — confirm all overrides survived the restart.
10. Tap **🤖 Model** → **↺ Reset to default** → `(default)` marker returns.
11. Inspect `~/.claude-mobile-bridge/settings.json` — verify JSON matches expected.

Tick each step as you go.

- [ ] **Step 9.2: Update README**

Append a new section to `README.md` under the commands table or near `## Channel Relay`:

```markdown
## Settings

`/settings` opens a persistent settings panel:

| Field          | Effect                                             |
| -------------- | -------------------------------------------------- |
| 🖥 Terminal    | Terminal used by `/new` and `/sessions → Resume`   |
| 📁 Working dir | Default project dir for `/new` (when no arg given) |
| 👁 Auto-watch  | Whether `/new` auto-attaches a watch after spawn   |
| 🤖 Model       | Default model — same state as `/model`             |

Values live in `~/.claude-mobile-bridge/settings.json` and take precedence over `.env`. Tap **↺ Reset to default** on any field to drop the override and fall back to the env value. Auto-watch cycles default → off → on → default on each tap.
```

- [ ] **Step 9.3: Commit**

```bash
git add README.md
git commit -m "docs: README — document /settings panel"
```

---

## Self-Review Checklist (fill in after drafting)

**Spec coverage:**

- Terminal app → Task 1 (getter), Task 2 (call site), Task 6 (sub-keyboard) ✓
- Working dir → Task 1, Task 2, Task 6 (edit flow), Task 7 (text hook) ✓
- Auto-watch toggle → Task 1, Task 4 (gate), Task 6 (cycle) ✓
- Default model persistence → Task 1, Task 3 (persist + startup), Task 6 (sub-keyboard) ✓
- Reset-to-default per field → Task 6 (set:reset branch) ✓
- Section headers in panel body → Task 5 (renderSettingsBody) ✓
- Flat 2x2 button layout → Task 5 (renderSettingsKeyboard) ✓
- Persistence outside /tmp → Task 1 (`~/.claude-mobile-bridge/settings.json`) ✓

**Placeholder scan:** no TBDs, every code block is concrete.

**Type consistency:**

- `BridgeSettings` interface used consistently across settings.ts, callback.ts, tests
- `TerminalApp` is imported from config.ts everywhere (not redefined)
- `ModelId` from session.ts used in callback.ts casts
- `saveSetting(patch)` signature identical wherever called

---

## Unresolved Questions

None — all design decisions locked during brainstorming.
