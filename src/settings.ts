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
  topicsEnabled?: boolean;
  enablePinnedStatus?: boolean;
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
  if (typeof o.topicsEnabled === "boolean") {
    out.topicsEnabled = o.topicsEnabled;
  }
  if (typeof o.enablePinnedStatus === "boolean") {
    out.enablePinnedStatus = o.enablePinnedStatus;
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

export function getTopicsEnabled(): boolean {
  return ensure().topicsEnabled ?? true;
}

export function getEnablePinnedStatus(): boolean {
  return ensure().enablePinnedStatus ?? true;
}

/**
 * Snapshot of currently-overridden fields. Used by the UI to show "(default)"
 * markers and decide whether "Reset" is meaningful.
 */
export function getOverrides(): BridgeSettings {
  return { ...ensure() };
}
