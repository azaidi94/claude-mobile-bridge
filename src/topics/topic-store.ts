/**
 * Persistence layer for topic ↔ session mappings.
 * In-memory cache with sync reads, async writes.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import type { TopicMapping, TopicStore } from "../types";
import { debug, info, warn } from "../logger";

function storePath(): string {
  return (
    process.env.CLAUDE_TELEGRAM_TOPICS_FILE ??
    join(homedir(), ".claude-mobile-bridge", "topics.json")
  );
}

// Previous default location. Kept for one-time migration on load —
// tmpdir is pruned by macOS, which silently orphans Telegram topics.
function legacyStorePath(): string {
  return join(tmpdir(), "claude-telegram-topics.json");
}

let dirEnsured = false;

async function ensureStoreDir(path: string): Promise<void> {
  if (dirEnsured) return;
  await mkdir(dirname(path), { recursive: true });
  dirEnsured = true;
}

let store: TopicStore = { chatId: 0, topics: [] };

export function getTopicStore(): TopicStore {
  return store;
}

export function setChatId(chatId: number): void {
  if (store.chatId === chatId) return;
  store.chatId = chatId;
  scheduleSave();
}

export async function loadTopicStore(): Promise<void> {
  const primary = storePath();
  try {
    const data = await readFile(primary, "utf-8");
    const parsed = JSON.parse(data) as TopicStore;
    if (parsed && Array.isArray(parsed.topics)) {
      store = parsed;
      debug(`topic-store: loaded ${store.topics.length} mapping(s)`);
      return;
    }
  } catch {
    // Fall through to legacy check
  }

  // Migrate from legacy tmpdir location (only when the user hasn't set an
  // explicit override — otherwise they're pointing at something deliberate).
  if (!process.env.CLAUDE_TELEGRAM_TOPICS_FILE) {
    const legacy = legacyStorePath();
    try {
      const data = await readFile(legacy, "utf-8");
      const parsed = JSON.parse(data) as TopicStore;
      if (parsed && Array.isArray(parsed.topics)) {
        store = parsed;
        info(
          `topic-store: migrated ${store.topics.length} mapping(s) from ${legacy} → ${primary}`,
        );
        await saveTopicStore();
      }
    } catch {
      // No legacy file either — start empty
    }
  }
}

export async function saveTopicStore(): Promise<void> {
  // Guard against clobbering the production store with default-state writes.
  // chatId===0 means no forum has been detected yet; there is nothing
  // meaningful to persist, and a save at this point would overwrite a
  // pre-existing valid file with an empty-default payload. The observed
  // pollution vector: a test triggers scheduleSave() while env isolation is
  // active, test teardown unsets CLAUDE_TELEGRAM_TOPICS_FILE, then the 100ms
  // debounced timer fires and writes to ~/.claude-mobile-bridge/topics.json.
  if (store.chatId === 0) {
    debug(`topic-store: skip save (chatId=0, nothing to persist)`);
    return;
  }
  const path = storePath();
  try {
    await ensureStoreDir(path);
    await writeFile(path, JSON.stringify(store, null, 2));
    debug(`topic-store: saved ${store.topics.length} mapping(s)`);
  } catch (err) {
    warn(`topic-store: save failed: ${err}`);
  }
}

let saveTimer: Timer | null = null;

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveTopicStore();
  }, 100);
}

export function addTopicMapping(mapping: TopicMapping): void {
  store.topics.push(mapping);
  scheduleSave();
}

export function removeTopicMapping(sessionName: string): void {
  store.topics = store.topics.filter((t) => t.sessionName !== sessionName);
  scheduleSave();
}

export function getTopicBySession(
  sessionName: string,
): TopicMapping | undefined {
  return store.topics.find((t) => t.sessionName === sessionName);
}

export function getSessionByTopic(topicId: number): TopicMapping | undefined {
  return store.topics.find((t) => t.topicId === topicId);
}

export function updateTopicMapping(
  sessionName: string,
  update: Partial<TopicMapping>,
): void {
  const mapping = store.topics.find((t) => t.sessionName === sessionName);
  if (mapping) {
    Object.assign(mapping, update);
    scheduleSave();
  }
}

export function clearTopicStore(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  dirEnsured = false;
  store = { chatId: 0, topics: [] };
}
