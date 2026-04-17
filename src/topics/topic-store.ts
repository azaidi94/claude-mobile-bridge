/**
 * Persistence layer for topic ↔ session mappings.
 * In-memory cache with sync reads, async writes.
 */

import { readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { TopicMapping, TopicStore } from "../types";
import { debug, warn } from "../logger";

function storePath(): string {
  return (
    process.env.CLAUDE_TELEGRAM_TOPICS_FILE ??
    join(tmpdir(), "claude-telegram-topics.json")
  );
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
  try {
    const data = await readFile(storePath(), "utf-8");
    const parsed = JSON.parse(data) as TopicStore;
    if (parsed && Array.isArray(parsed.topics)) {
      store = parsed;
      debug(`topic-store: loaded ${store.topics.length} mapping(s)`);
    }
  } catch {
    // No file yet — start empty
  }
}

export async function saveTopicStore(): Promise<void> {
  try {
    await writeFile(storePath(), JSON.stringify(store, null, 2));
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
  store = { chatId: 0, topics: [] };
}
