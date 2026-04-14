/**
 * Session lifecycle notifications.
 *
 * Tracks chat IDs of allowed users and sends notifications
 * when desktop sessions come online or go offline.
 */

import { readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { InlineKeyboard, type Api } from "grammy";
import type { SessionInfo } from "./types";
import { info, warn } from "../logger";
import { getActiveSession } from "./watcher";
import { getTopicsEnabled } from "../settings";
import type { TopicManager } from "../topics";

const CHAT_IDS_FILE = join(tmpdir(), "claude-telegram-chat-ids.json");
const FLAP_BUFFER_MS = 2_000;
// Long enough for the relay child to exit after SIGTERM and for the next
// discovery scan to clean up its stale port file (relay shutdown ≈ a few s,
// discovery TTL is 5s in src/relay/discovery.ts).
const KILL_SUPPRESS_MS = 15_000;

// Registered chat IDs of allowed users
const chatIds = new Set<number>();

// Pending notifications buffered for flap suppression
// key: session dir
interface PendingNotification {
  type: "added" | "removed";
  name: string;
  dir: string;
  timer: Timer;
}
const pending = new Map<string, PendingNotification>();

// Dirs whose add/remove notifications should be dropped — used by /kill so the
// dying relay's lingering port file doesn't trigger a spurious online → offline
// flap before its process actually exits. Keyed by session dir.
const suppressedDirs = new Map<string, Timer>();

/**
 * Suppress add/remove notifications for a session dir.
 *
 * Called by killSession (default `KILL_SUPPRESS_MS`) to prevent spurious
 * online/offline notifications while the relay child winds down.
 *
 * Also called by `spawnDesktopClaudeSession` with a longer window
 * (~150s, just beyond the spawn detection deadline) so the background
 * watcher's redundant "🟢 online" broadcast doesn't stack on top of the
 * spawn flow's own status message.
 */
export function suppressDirNotifications(
  dir: string,
  durationMs: number = KILL_SUPPRESS_MS,
): void {
  const existing = suppressedDirs.get(dir);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => suppressedDirs.delete(dir), durationMs);
  suppressedDirs.set(dir, timer);

  // Also cancel any in-flight pending notification for this dir.
  const inFlight = pending.get(dir);
  if (inFlight) {
    clearTimeout(inFlight.timer);
    pending.delete(dir);
  }
}

/**
 * Register a chat ID (called from middleware on every message).
 */
export function registerChatId(chatId: number): void {
  if (chatIds.has(chatId)) return;
  chatIds.add(chatId);
  saveChatIds();
}

/**
 * Remove a chat from notification targets (e.g. stale ID from disk).
 */
export function removeChatId(chatId: number): void {
  if (chatIds.delete(chatId)) saveChatIds();
}

/**
 * Get all registered chat IDs.
 */
export function getChatIds(): Set<number> {
  return chatIds;
}

function isTelegramChatNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b400\b/.test(msg) && /chat not found/i.test(msg);
}

/**
 * Load persisted chat IDs from disk.
 */
export async function loadChatIds(): Promise<void> {
  try {
    const data = await readFile(CHAT_IDS_FILE, "utf-8");
    const ids: number[] = JSON.parse(data);
    for (const id of ids) chatIds.add(id);
  } catch {
    // No file yet
  }
}

/**
 * Save chat IDs to disk.
 */
function saveChatIds(): void {
  writeFile(CHAT_IDS_FILE, JSON.stringify([...chatIds])).catch(() => {});
}

export interface SessionDiff {
  added: SessionInfo[];
  removed: { name: string; dir: string }[];
}

// Callback for when sessions go offline (used by watch handler for resume)
let onSessionOfflineCallback:
  | ((botApi: Api, sessionDir: string) => void)
  | null = null;

/**
 * Set a callback to be notified when sessions go offline.
 * Used by the watch handler to trigger resume flow.
 */
export function setSessionOfflineCallback(
  callback: (botApi: Api, sessionDir: string) => void,
): void {
  onSessionOfflineCallback = callback;
}

/**
 * Create the onChange callback for the watcher.
 * Buffers notifications for FLAP_BUFFER_MS to suppress rapid on/off flapping.
 */
export function createNotificationHandler(
  botApi: Api,
  topicManager?: TopicManager,
): (diff: SessionDiff) => void {
  return (diff: SessionDiff) => {
    for (const session of diff.added) {
      if (suppressedDirs.has(session.dir)) {
        info(`notify: suppressed add for killed ${session.name}`);
        continue;
      }
      const existing = pending.get(session.dir);
      if (existing?.type === "removed") {
        // Session reappeared within buffer — cancel removal, skip both
        clearTimeout(existing.timer);
        pending.delete(session.dir);
        info(`notify: suppressed flap for ${session.name}`);
        continue;
      }
      const timer = setTimeout(() => {
        pending.delete(session.dir);
        if (topicManager && getTopicsEnabled()) {
          topicManager
            .createTopic(session.name, session.dir, session.id)
            .catch((err) =>
              warn(`notify: topic create failed for ${session.name}: ${err}`),
            );
        }
        broadcast(
          botApi,
          `🟢 <b>${escHtml(session.name)}</b> online\n<code>${escHtml(session.dir)}</code>`,
          getTopicsEnabled()
            ? undefined
            : new InlineKeyboard().text("👁 Watch", `switch:${session.name}`),
        );
      }, FLAP_BUFFER_MS);
      pending.set(session.dir, {
        type: "added",
        name: session.name,
        dir: session.dir,
        timer,
      });
    }

    for (const session of diff.removed) {
      if (suppressedDirs.has(session.dir)) {
        info(`notify: suppressed remove for killed ${session.name}`);
        continue;
      }
      const existing = pending.get(session.dir);
      if (existing?.type === "added") {
        // Session disappeared before add notification fired — cancel, skip both
        clearTimeout(existing.timer);
        pending.delete(session.dir);
        info(`notify: suppressed flap for ${session.name}`);
        continue;
      }
      const active = getActiveSession();
      const wasActive = active?.info.dir === session.dir;
      const timer = setTimeout(() => {
        pending.delete(session.dir);

        // Notify watch handler for resume flow
        onSessionOfflineCallback?.(botApi, session.dir);

        if (topicManager && getTopicsEnabled()) {
          topicManager
            .deleteTopic(session.name)
            .catch((err) =>
              warn(`notify: topic delete failed for ${session.name}: ${err}`),
            );
        }

        let msg = `🔴 <b>${escHtml(session.name)}</b> offline\n<code>${escHtml(session.dir)}</code>`;
        if (wasActive) msg += "\n⚠️ was active session";
        broadcast(botApi, msg);
      }, FLAP_BUFFER_MS);
      pending.set(session.dir, {
        type: "removed",
        name: session.name,
        dir: session.dir,
        timer,
      });
    }
  };
}

function broadcast(
  botApi: Api,
  html: string,
  replyMarkup?: InlineKeyboard,
): void {
  for (const chatId of chatIds) {
    botApi
      .sendMessage(chatId, html, {
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      })
      .catch((err) => {
        if (isTelegramChatNotFoundError(err)) {
          removeChatId(chatId);
          info(`notify: removed unreachable chat_id=${chatId}`);
          return;
        }
        warn(`notify send: ${err}`);
      });
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
