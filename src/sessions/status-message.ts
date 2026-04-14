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
import { getEnablePinnedStatus } from "../settings";

/**
 * Get current git branch for a directory.
 */
export async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const branch = text.trim();
    return branch || null;
  } catch {
    return null;
  }
}

const STATUS_FILE = join(tmpdir(), "claude-telegram-pinned-messages.json");

// Map of key -> pinnedMessageId (key = "chatId" or "chatId:topicId")
const pinnedMessageIds = new Map<string, number>();

function pinnedKey(chatId: number, topicId?: number): string {
  return topicId ? `${chatId}:${topicId}` : `${chatId}`;
}

/**
 * Load pinned message IDs from disk.
 */
export async function loadPinnedMessageIds(): Promise<void> {
  try {
    const data = await readFile(STATUS_FILE, "utf-8");
    const parsed: Record<string, number> = JSON.parse(data);
    for (const [k, v] of Object.entries(parsed)) {
      pinnedMessageIds.set(k, v);
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
 * Get pinned message ID for a chat (optionally per-topic).
 */
export function getPinnedMessageId(
  chatId: number,
  topicId?: number,
): number | undefined {
  return pinnedMessageIds.get(pinnedKey(chatId, topicId));
}

/**
 * Set pinned message ID for a chat (optionally per-topic).
 */
export function setPinnedMessageId(
  chatId: number,
  messageId: number,
  topicId?: number,
): void {
  pinnedMessageIds.set(pinnedKey(chatId, topicId), messageId);
  savePinnedMessageIds();
}

/**
 * Clear pinned message ID for a chat (optionally per-topic).
 */
export function clearPinnedMessageId(chatId: number, topicId?: number): void {
  pinnedMessageIds.delete(pinnedKey(chatId, topicId));
  savePinnedMessageIds();
}

export interface StatusInfo {
  sessionName: string | null;
  isPlanMode: boolean;
  model: string;
  branch?: string | null;
  isWatching?: string | null; // session name being watched
}

/**
 * Format status message text.
 */
export function formatStatusMessage(status: StatusInfo): string {
  if (status.isWatching) {
    const parts = [`👁 Watching: ${status.isWatching}`, status.model];
    if (status.branch) parts.push(`🌿 ${status.branch}`);
    return parts.join(" | ");
  }

  const name = status.sessionName || "no session";
  const mode = status.isPlanMode ? "📋 Plan" : "⚡ Normal";
  const parts = [`✅ ${name}`, mode, status.model];
  if (status.branch) parts.push(`🌿 ${status.branch}`);
  return parts.join(" | ");
}

/**
 * Update pinned status message for a chat.
 * Creates new message + pins if none exists, otherwise edits existing.
 */
export async function updatePinnedStatus(
  api: Api,
  chatId: number,
  status: StatusInfo,
  topicId?: number,
): Promise<void> {
  if (!getEnablePinnedStatus()) return;

  const key = pinnedKey(chatId, topicId);
  const text = formatStatusMessage(status);
  const existingId = pinnedMessageIds.get(key);

  if (existingId) {
    // Try to edit existing message
    try {
      await api.editMessageText(chatId, existingId, text);
      debug(`status: updated ${key}`);
      return;
    } catch (err) {
      // Message was deleted or unavailable - create new one
      debug(`status: recreating for ${key}: ${err}`);
      pinnedMessageIds.delete(key);
    }
  }

  // Create new message and pin it
  try {
    const msg = await api.sendMessage(chatId, text, {
      message_thread_id: topicId,
    });
    await api.pinChatMessage(chatId, msg.message_id, {
      disable_notification: true,
    });
    pinnedMessageIds.set(key, msg.message_id);
    await savePinnedMessageIds();
    info(`status: pinned ${key}`);
  } catch (err) {
    warn(`status: pin failed ${key}: ${err}`);
  }
}

/**
 * Remove pinned status message for a chat.
 */
export async function removePinnedStatus(
  api: Api,
  chatId: number,
  topicId?: number,
): Promise<void> {
  const key = pinnedKey(chatId, topicId);
  const existingId = pinnedMessageIds.get(key);
  if (!existingId) return;

  try {
    await api.unpinChatMessage(chatId, existingId);
    await api.deleteMessage(chatId, existingId);
    debug(`status: removed ${key}`);
  } catch (err) {
    debug(`status: remove failed ${key}: ${err}`);
  }

  pinnedMessageIds.delete(key);
  await savePinnedMessageIds();
}
