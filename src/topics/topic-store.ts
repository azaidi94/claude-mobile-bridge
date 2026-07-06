/**
 * Persistence layer for topic ↔ session mappings.
 * In-memory cache with sync reads, async writes.
 */

import { readFile, writeFile, mkdir, rename, stat } from "fs/promises";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import type { TopicMapping, TopicStore } from "../types";
export type { TopicMapping };
import { debug, warn } from "../logger";
import { withFileLock } from "./file-lock";

function storePath(): string {
  return (
    process.env.CLAUDE_TELEGRAM_TOPICS_FILE ??
    join(homedir(), ".claude-mobile-bridge", "topics.json")
  );
}

// Pre-2026 default location. We no longer auto-migrate — if data is still
// stranded here, refuse to start so the operator can move it deliberately.
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
  let primaryExists = false;
  try {
    const data = await readFile(primary, "utf-8");
    const parsed = JSON.parse(data) as TopicStore;
    if (parsed && Array.isArray(parsed.topics)) {
      store = parsed;
      primaryExists = true;
      debug(`topic-store: loaded ${store.topics.length} mapping(s)`);
    }
  } catch {
    // Primary missing or unreadable — proceed to legacy check below.
  }

  // Refuse to silently auto-migrate. If legacy data is still around and the
  // primary store has nothing, the operator needs to move it deliberately
  // (or risk overwriting fresh data on the next save).
  if (!primaryExists && !process.env.CLAUDE_TELEGRAM_TOPICS_FILE) {
    const legacy = legacyStorePath();
    try {
      await stat(legacy);
      throw new Error(
        `topic-store: legacy file found at ${legacy} but no primary store ` +
          `at ${primary}. Auto-migration has been removed. ` +
          `Run: mv "${legacy}" "${primary}" (creating the parent dir if needed) ` +
          `and restart.`,
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("topic-store:")) {
        throw err;
      }
      // Legacy file absent — start empty.
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
    // Serialise writes across bot processes sharing this file, and write
    // atomically (temp + rename) so a concurrent reader never sees torn JSON.
    await withFileLock(path, async () => {
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(store, null, 2));
      await rename(tmp, path);
    });
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

export function getTopicBySessionDir(
  sessionDir: string,
): TopicMapping | undefined {
  return store.topics.find((t) => t.sessionDir === sessionDir);
}

/**
 * Look up a topic by its Claude sessionId. Unlike `getTopicBySessionDir`, this
 * is sibling-safe: two sessions in the same folder have distinct sessionIds, so
 * routing by id (not dir) lands each session's messages in its own topic.
 */
export function getTopicBySessionId(
  sessionId: string,
): TopicMapping | undefined {
  if (!sessionId) return undefined;
  return store.topics.find((t) => t.sessionId === sessionId);
}

export function updateTopicMapping(
  sessionName: string,
  update: Partial<TopicMapping>,
): void {
  const mapping = store.topics.find((t) => t.sessionName === sessionName);
  if (mapping) {
    // Strip undefined values and protect a stored non-empty sessionId from
    // being wiped by a falsy update (port-file sessions carry id: ""; startup
    // reconcile passes s.id likewise — either would clobber a valid UUID).
    const safe: Partial<TopicMapping> = {};
    for (const [k, v] of Object.entries(update) as [
      keyof TopicMapping,
      unknown,
    ][]) {
      if (v === undefined) continue;
      if (k === "sessionId" && !v && mapping.sessionId) continue;
      (safe as Record<string, unknown>)[k] = v;
    }
    Object.assign(mapping, safe);
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
