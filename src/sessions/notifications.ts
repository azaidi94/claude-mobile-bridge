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

const CHAT_IDS_FILE = join(tmpdir(), "claude-telegram-chat-ids.json");
const FLAP_BUFFER_MS = 2_000;

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

/**
 * Register a chat ID (called from middleware on every message).
 */
export function registerChatId(chatId: number): void {
  if (chatIds.has(chatId)) return;
  chatIds.add(chatId);
  saveChatIds();
}

/**
 * Get all registered chat IDs.
 */
export function getChatIds(): Set<number> {
  return chatIds;
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
): (diff: SessionDiff) => void {
  return (diff: SessionDiff) => {
    for (const session of diff.added) {
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
        broadcast(
          botApi,
          `🟢 <b>${escHtml(session.name)}</b> online\n<code>${escHtml(session.dir)}</code>`,
          new InlineKeyboard().text("👁 Watch", `switch:${session.name}`),
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
      .catch((err) => warn(`notify send: ${err}`));
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
