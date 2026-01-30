/**
 * Status message tracking for pinned Telegram messages.
 *
 * Auto-updates pinned message showing session mode and model.
 * Format: ✅ session-name | 📋 Plan / ⚡ Normal | Model
 */

import { readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Api } from "grammy";
import { info, warn, debug } from "../logger";

const STATUS_FILE = join(tmpdir(), "claude-telegram-pinned-messages.json");

// Map of chatId -> pinnedMessageId
const pinnedMessageIds = new Map<number, number>();

/**
 * Load pinned message IDs from disk.
 */
export async function loadPinnedMessageIds(): Promise<void> {
  try {
    const data = await readFile(STATUS_FILE, "utf-8");
    const parsed: Record<string, number> = JSON.parse(data);
    for (const [k, v] of Object.entries(parsed)) {
      pinnedMessageIds.set(Number(k), v);
    }
    debug(`status: loaded ${pinnedMessageIds.size} pinned msg(s)`);
  } catch {
    // No file yet
  }
}

/**
 * Save pinned message IDs to disk.
 */
async function savePinnedMessageIds(): Promise<void> {
  const obj: Record<string, number> = {};
  for (const [k, v] of pinnedMessageIds) {
    obj[String(k)] = v;
  }
  await writeFile(STATUS_FILE, JSON.stringify(obj)).catch(() => {});
}

/**
 * Get pinned message ID for a chat.
 */
export function getPinnedMessageId(chatId: number): number | undefined {
  return pinnedMessageIds.get(chatId);
}

/**
 * Set pinned message ID for a chat.
 */
export function setPinnedMessageId(chatId: number, messageId: number): void {
  pinnedMessageIds.set(chatId, messageId);
  savePinnedMessageIds();
}

/**
 * Clear pinned message ID for a chat.
 */
export function clearPinnedMessageId(chatId: number): void {
  pinnedMessageIds.delete(chatId);
  savePinnedMessageIds();
}

export interface StatusInfo {
  sessionName: string | null;
  isPlanMode: boolean;
  model: string;
}

/**
 * Format status message text.
 */
export function formatStatusMessage(status: StatusInfo): string {
  const name = status.sessionName || "no session";
  const mode = status.isPlanMode ? "📋 Plan" : "⚡ Normal";
  return `✅ ${name} | ${mode} | ${status.model}`;
}

/**
 * Update pinned status message for a chat.
 * Creates new message + pins if none exists, otherwise edits existing.
 */
export async function updatePinnedStatus(
  api: Api,
  chatId: number,
  status: StatusInfo,
): Promise<void> {
  const text = formatStatusMessage(status);
  const existingId = pinnedMessageIds.get(chatId);

  if (existingId) {
    // Try to edit existing message
    try {
      await api.editMessageText(chatId, existingId, text);
      debug(`status: updated ${chatId}`);
      return;
    } catch (err) {
      // Message was deleted or unavailable - create new one
      debug(`status: recreating for ${chatId}: ${err}`);
      pinnedMessageIds.delete(chatId);
    }
  }

  // Create new message and pin it
  try {
    const msg = await api.sendMessage(chatId, text);
    await api.pinChatMessage(chatId, msg.message_id, {
      disable_notification: true,
    });
    pinnedMessageIds.set(chatId, msg.message_id);
    await savePinnedMessageIds();
    info(`status: pinned ${chatId}`);
  } catch (err) {
    warn(`status: pin failed ${chatId}: ${err}`);
  }
}

/**
 * Remove pinned status message for a chat.
 */
export async function removePinnedStatus(
  api: Api,
  chatId: number,
): Promise<void> {
  const existingId = pinnedMessageIds.get(chatId);
  if (!existingId) return;

  try {
    await api.unpinChatMessage(chatId, existingId);
    await api.deleteMessage(chatId, existingId);
    debug(`status: removed ${chatId}`);
  } catch (err) {
    debug(`status: remove failed ${chatId}: ${err}`);
  }

  pinnedMessageIds.delete(chatId);
  await savePinnedMessageIds();
}
