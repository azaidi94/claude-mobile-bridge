/**
 * Permission bridge — watches for permission requests from desktop Claude
 * sessions and surfaces them as Telegram inline buttons.
 *
 * Protocol:
 *   Hook writes /tmp/claude-permissions/{id}.req
 *   Bot shows Telegram buttons
 *   Bot writes /tmp/claude-permissions/{id}.res on user response
 *   Hook reads response and returns decision to Claude
 */

import {
  watch,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  type FSWatcher,
} from "fs";
import { readFile } from "fs/promises";
import type { Api } from "grammy";
import { dirHash } from "./relay/discovery";
import { escapeHtml } from "./formatting";
import { debug, info, warn } from "./logger";

const PERM_DIR = "/tmp/claude-permissions";
const AUTO_DENY_MS = 115_000; // slightly under hook's 120s timeout

interface PermissionRequest {
  id: string;
  tool_name: string;
  description: string;
  cwd: string;
  timestamp: number;
}

interface PendingPermission {
  chatId: number;
  messageId: number;
  description: string;
  timer: Timer;
}

// dirHash → { chatId, botApi }
const watchedChats = new Map<string, { chatId: number; botApi: Api }>();

// request ID → pending state
const pending = new Map<string, PendingPermission>();

let fsWatcher: FSWatcher | null = null;

/**
 * Register that the bot is watching a session (enables permission bridging).
 */
export function addPermissionWatch(
  dir: string,
  chatId: number,
  botApi: Api,
): void {
  const hash = dirHash(dir);
  watchedChats.set(hash, { chatId, botApi });

  try {
    mkdirSync(PERM_DIR, { recursive: true });
    writeFileSync(`${PERM_DIR}/watch-${hash}`, String(chatId));
  } catch (err) {
    warn(`perm: signal write failed: ${err}`);
  }

  ensureWatcher();
  debug(`perm: watch added for ${dir} → chat ${chatId}`);
}

/**
 * Remove watch signal for a directory.
 */
export function removePermissionWatch(dir: string): void {
  const hash = dirHash(dir);
  watchedChats.delete(hash);
  try {
    unlinkSync(`${PERM_DIR}/watch-${hash}`);
  } catch {}
}

/**
 * Remove all permission watches for a chat.
 */
export function removePermissionWatchForChat(chatId: number): void {
  for (const [hash, entry] of watchedChats) {
    if (entry.chatId === chatId) {
      watchedChats.delete(hash);
      try {
        unlinkSync(`${PERM_DIR}/watch-${hash}`);
      } catch {}
    }
  }
}

/**
 * Resolve a permission request (from callback handler).
 */
export function resolvePermission(
  id: string,
  decision: "allow" | "deny",
  botApi: Api,
): boolean {
  const entry = pending.get(id);
  if (!entry) return false;

  clearTimeout(entry.timer);
  pending.delete(id);

  // Write response file for the hook to read
  const resFile = `${PERM_DIR}/${id}.res`;
  try {
    const response =
      decision === "allow"
        ? { decision: "allow" }
        : { decision: "deny", reason: "Denied via Telegram" };
    writeFileSync(resFile, JSON.stringify(response));
  } catch (err) {
    warn(`perm: write response failed: ${err}`);
    return false;
  }

  // Update Telegram message
  const emoji = decision === "allow" ? "✅" : "❌";
  const label = decision === "allow" ? "Allowed" : "Denied";
  botApi
    .editMessageText(
      entry.chatId,
      entry.messageId,
      `${emoji} ${label}: ${entry.description}`,
    )
    .catch(() => {});

  info(`perm: ${decision} (${id})`);
  return true;
}

/**
 * Clean up all state on shutdown.
 */
export function cleanupPermissions(): void {
  fsWatcher?.close();
  fsWatcher = null;

  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
  }
  pending.clear();

  for (const hash of watchedChats.keys()) {
    try {
      unlinkSync(`${PERM_DIR}/watch-${hash}`);
    } catch {}
  }
  watchedChats.clear();
}

// ── Internal ────────────────────────────────────────────────────────────

function ensureWatcher(): void {
  if (fsWatcher) return;

  try {
    mkdirSync(PERM_DIR, { recursive: true });
    fsWatcher = watch(PERM_DIR, (_, filename) => {
      if (filename?.endsWith(".req")) {
        setTimeout(() => handleRequest(filename), 150);
      }
    });
    debug("perm: watcher started");
  } catch (err) {
    warn(`perm: watcher failed: ${err}`);
  }
}

async function handleRequest(filename: string): Promise<void> {
  const filePath = `${PERM_DIR}/${filename}`;

  const req = await readJsonRetry<PermissionRequest>(filePath);
  if (!req) return;

  // Find watching chat for this session
  const hash = dirHash(req.cwd);
  const watched = watchedChats.get(hash);
  if (!watched) {
    debug(`perm: no watcher for ${req.cwd}`);
    return;
  }

  const { chatId, botApi } = watched;
  const desc = escapeHtml(req.description.slice(0, 200));

  try {
    const msg = await botApi.sendMessage(
      chatId,
      `🔐 <b>Permission: ${escapeHtml(req.tool_name)}</b>\n<code>${desc}</code>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Allow", callback_data: `perm:allow:${req.id}` },
              { text: "❌ Deny", callback_data: `perm:deny:${req.id}` },
            ],
          ],
        },
      },
    );

    // Auto-deny on timeout
    const timer = setTimeout(() => {
      resolvePermission(req.id, "deny", botApi);
    }, AUTO_DENY_MS);

    pending.set(req.id, {
      chatId,
      messageId: msg.message_id,
      description: req.description.slice(0, 200),
      timer,
    });

    info(`perm: prompted ${req.tool_name} (${req.id})`);
  } catch (err) {
    warn(`perm: send failed: ${err}`);
  }
}

async function readJsonRetry<T>(path: string): Promise<T | null> {
  for (let i = 0; i < 2; i++) {
    try {
      return JSON.parse(await readFile(path, "utf-8"));
    } catch {
      if (i === 0) await new Promise((r) => setTimeout(r, 200));
    }
  }
  return null;
}
