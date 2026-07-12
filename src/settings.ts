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
  enablePinnedStatus?: boolean;
  /** Surface transcript images (screenshots, image Reads, pasted images) to TG. */
  watchImages?: boolean;
  /**
   * Routing mode. `true` = supergroup topics (DMs blocked).
   * `false` = private DM (group messages blocked).
   * `undefined` = auto (follow forum-group detection at runtime).
   */
  groupMode?: boolean;
  /**
   * Context-usage notification step in percent.
   * 0 (default) = off. Valid non-zero values: 10, 25, 50.
   */
  contextNotifyStep?: number;
  /**
   * Cursor AI bridge toggle. `true` (default) = enabled. `false` = disabled.
   * Can also be disabled at startup via CURSOR_BRIDGE_ENABLED env var.
   */
  cursorEnabled?: boolean;
  /**
   * Name of the single Cursor session whose AI replies are forwarded to
   * Telegram. `undefined` = nothing subscribed (bridge may still be attached
   * to windows, but no cross-posting happens). Persisted so the choice
   * survives restarts and re-wires once the window re-attaches.
   */
  cursorSubscribedSession?: string;
  /**
   * Default verbose (full-transcript) streaming for new /ralph loops.
   * `undefined`/`false` = off (default). Per-loop `/ralph verbose on|off`
   * still overrides at runtime.
   */
  ralphVerboseDefault?: boolean;
  /**
   * How much of a session's activity streams to Telegram (the /watch + relay
   * display pipeline). `0` = quiet (final text only; tool/thinking/result cards
   * suppressed), `1` = normal (default — full stream), `2` = detailed (reserved
   * for future extra tool-input/reasoning expansion; currently == 1). Set via
   * `/verbose 0|1|2` or VERBOSE_LEVEL env.
   */
  verboseLevel?: number;
  /**
   * Default GitHub issue label new /ralph loops scope to. Empty/undefined =
   * no `--label` (the script decides scope — the neutral default so custom
   * RALPH_SCRIPTs that don't use labels are unaffected). `-l <x>` overrides
   * per-run; `-l -` forces no label even when this is set.
   */
  defaultRalphLabel?: string;
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
  if (typeof o.enablePinnedStatus === "boolean") {
    out.enablePinnedStatus = o.enablePinnedStatus;
  }
  if (typeof o.watchImages === "boolean") {
    out.watchImages = o.watchImages;
  }
  if (typeof o.groupMode === "boolean") {
    out.groupMode = o.groupMode;
  }
  if (typeof o.contextNotifyStep === "number") {
    if ([0, 10, 25, 50].includes(o.contextNotifyStep)) {
      out.contextNotifyStep = o.contextNotifyStep;
    }
  }
  if (typeof o.cursorEnabled === "boolean") {
    out.cursorEnabled = o.cursorEnabled;
  }
  if (typeof o.cursorSubscribedSession === "string") {
    out.cursorSubscribedSession = o.cursorSubscribedSession;
  }
  if (typeof o.ralphVerboseDefault === "boolean") {
    out.ralphVerboseDefault = o.ralphVerboseDefault;
  }
  if (
    typeof o.verboseLevel === "number" &&
    [0, 1, 2].includes(o.verboseLevel)
  ) {
    out.verboseLevel = o.verboseLevel;
  }
  if (typeof o.defaultRalphLabel === "string") {
    out.defaultRalphLabel = o.defaultRalphLabel;
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
    warn("settings: load failed", err, { path });
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
    debug("settings: saved", { keys: Object.keys(patch).join(",") });
  } catch (err) {
    warn("settings: save failed", err);
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

export function getEnablePinnedStatus(): boolean {
  return ensure().enablePinnedStatus ?? true;
}

export function getWatchImages(): boolean {
  return ensure().watchImages ?? true;
}

/** Explicit group-mode override, or undefined for auto-detect. */
export function getGroupModeSetting(): boolean | undefined {
  return ensure().groupMode;
}

export function getContextNotifyStep(): number {
  return ensure().contextNotifyStep ?? 0;
}

export function getCursorEnabled(): boolean {
  return ensure().cursorEnabled ?? true;
}

/** Name of the subscribed Cursor session, or undefined if none. */
export function getCursorSubscribedSession(): string | undefined {
  return ensure().cursorSubscribedSession;
}

/** Whether new /ralph loops start with verbose transcript streaming on. */
export function getRalphVerboseDefault(): boolean {
  return ensure().ralphVerboseDefault ?? false;
}

/**
 * How much session activity streams to Telegram: 0 quiet, 1 normal (default),
 * 2 detailed. Precedence: settings file → VERBOSE_LEVEL env → 1. Invalid values
 * fall through to the default.
 */
export function getVerboseLevel(): 0 | 1 | 2 {
  const fromSetting = ensure().verboseLevel;
  if (fromSetting === 0 || fromSetting === 1 || fromSetting === 2) {
    return fromSetting;
  }
  const env = Number(process.env.VERBOSE_LEVEL);
  if (env === 0 || env === 1 || env === 2) return env;
  return 1;
}

/** Default issue label for new /ralph loops; "" = no label filter. */
export function getDefaultRalphLabel(): string {
  return ensure().defaultRalphLabel ?? "";
}

/**
 * Snapshot of currently-overridden fields. Used by the UI to show "(default)"
 * markers and decide whether "Reset" is meaningful.
 */
export function getOverrides(): BridgeSettings {
  return { ...ensure() };
}
