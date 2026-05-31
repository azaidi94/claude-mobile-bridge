/**
 * Persistent registry for saved prompts at
 * ~/.claude-mobile-bridge/prompts.json. Lets users build a tappable menu
 * of frequently-used prompts that get injected into the current session
 * topic as if they'd typed them.
 */

import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import { homedir } from "os";
import { info, warn } from "../logger";

export interface SavedPrompt {
  id: string;
  label: string; // short — used as button text
  text: string; // full prompt
  sessionScope?: string; // optional: only show in this session's topic
  createdAt: string;
}

interface PromptStore {
  prompts: SavedPrompt[];
}

function storePath(): string {
  return (
    process.env.PROMPTS_STORE_PATH ||
    `${homedir()}/.claude-mobile-bridge/prompts.json`
  );
}

let cache: PromptStore = { prompts: [] };
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
      const parsed = JSON.parse(raw) as PromptStore;
      if (parsed && Array.isArray(parsed.prompts)) cache = parsed;
    }
  } catch (err) {
    warn(`prompt-store: load failed, starting empty: ${err}`);
    cache = { prompts: [] };
  }
  loaded = true;
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void persist();
  }, 250);
}

async function persist(): Promise<void> {
  await ensureDir();
  const tmp = `${storePath()}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2));
  await rename(tmp, storePath());
}

/** Return prompts visible in `scope`: unscoped + ones matching `scope`. */
export async function getPrompts(scope?: string): Promise<SavedPrompt[]> {
  await load();
  return cache.prompts.filter(
    (p) => !p.sessionScope || (scope && p.sessionScope === scope),
  );
}

export async function getById(id: string): Promise<SavedPrompt | undefined> {
  await load();
  return cache.prompts.find((p) => p.id === id);
}

export async function addPrompt(
  input: Omit<SavedPrompt, "id" | "createdAt"> & { id?: string },
): Promise<SavedPrompt> {
  await load();
  const id =
    input.id ||
    `p${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const created: SavedPrompt = {
    id,
    label: input.label,
    text: input.text,
    sessionScope: input.sessionScope,
    createdAt: new Date().toISOString(),
  };
  cache.prompts.push(created);
  scheduleSave();
  info(`prompt-store: added ${id} (${input.label})`);
  return created;
}

export async function removePrompt(id: string): Promise<boolean> {
  await load();
  const before = cache.prompts.length;
  cache.prompts = cache.prompts.filter((p) => p.id !== id);
  if (cache.prompts.length !== before) {
    scheduleSave();
    info(`prompt-store: removed ${id}`);
    return true;
  }
  return false;
}

/** Test seam. */
export function _resetPromptStoreForTesting(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  cache = { prompts: [] };
  loaded = false;
}
