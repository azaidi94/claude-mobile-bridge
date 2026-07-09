/**
 * Persistent LRU of recently-run skills/commands at
 * ~/.claude-mobile-bridge/skill-recents.json. Powers the 🕘 Recent row on
 * the /skills search-first landing screen.
 *
 * Stored as a flat global list (most-recent first). Which skills actually
 * exist depends on the session's cwd, so callers intersect this list with
 * the live enumeration at render time — stale names simply drop off.
 *
 * Mirrors src/prompts/store.ts: lazy load, debounced save, atomic write.
 */

import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import { homedir } from "os";
import { info, warn } from "../logger";

interface RecentsStore {
  recents: string[]; // skill names, most-recent first
}

// Keep more than we display (~3-5) so recents survive being filtered down
// to what's available in the current cwd.
const CAP = 12;

function storePath(): string {
  return (
    process.env.SKILL_RECENTS_STORE_PATH ||
    `${homedir()}/.claude-mobile-bridge/skill-recents.json`
  );
}

let cache: RecentsStore = { recents: [] };
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function ensureDir(): Promise<void> {
  const dir = dirname(storePath());
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

async function load(): Promise<void> {
  if (loaded) return;
  try {
    if (existsSync(storePath())) {
      const raw = await readFile(storePath(), "utf-8");
      const parsed = JSON.parse(raw) as RecentsStore;
      if (parsed && Array.isArray(parsed.recents)) {
        cache = {
          recents: parsed.recents.filter((n) => typeof n === "string"),
        };
      }
    }
  } catch (err) {
    warn(`skill-recents: load failed, starting empty: ${err}`);
    cache = { recents: [] };
  }
  loaded = true;
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    persist().catch((err) => warn(`skill-recents: persist failed`, err));
  }, 250);
}

async function persist(): Promise<void> {
  await ensureDir();
  const tmp = `${storePath()}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2));
  await rename(tmp, storePath());
}

/** Cancel pending debounced save and persist immediately. */
export async function flush(): Promise<void> {
  // Never wrote this session → nothing to persist. Guards against a shutdown
  // flush clobbering the on-disk file with the default-empty cache.
  if (!loaded) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await persist();
}

/** Most-recent-first list of skill names. Caller filters to what's available. */
export async function getRecents(): Promise<string[]> {
  await load();
  return cache.recents.slice();
}

/** Record a run: move `name` to the front, dedup, cap at CAP. */
export async function recordUse(name: string): Promise<void> {
  await load();
  cache.recents = [name, ...cache.recents.filter((n) => n !== name)].slice(
    0,
    CAP,
  );
  scheduleSave();
  info(`skill-recents: used ${name}`);
}

/** Test seam. */
export function _resetSkillRecentsForTesting(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  cache = { recents: [] };
  loaded = false;
}
