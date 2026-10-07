/**
 * "➕ New folder…" follow-up for the folder browser. The tap records which
 * folder we are in (and what "Open here" should dispatch afterwards); the
 * next text message in that topic is the new folder's name.
 */

import type { FolderPick } from "./folder-browser";

export interface PendingFolderCreate {
  parent: string;
  onPick: FolderPick;
  createdAt: number;
}

export const PENDING_FOLDER_TTL_MS = 10 * 60 * 1000;

/** pendingKey(chatId, threadId) → where the next message creates a folder. */
export const pendingFolderCreate = new Map<string, PendingFolderCreate>();

export type FolderNameOutcome =
  | { kind: "cancel" }
  | { kind: "invalid"; reason: string }
  | { kind: "create"; name: string; parent: string; onPick: FolderPick };

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;

export function validateFolderName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return "Name can't be empty.";
  if (name === "." || name === "..") return "That name isn't allowed.";
  if (name.includes("/") || name.includes("\\"))
    return "No slashes — one folder level at a time.";
  if (!NAME_RE.test(name)) {
    return "Use letters, digits, space, . _ - (max 64 chars, not starting with a dot).";
  }
  return null;
}

/** Consume the pending entry for `key`. Null when nothing is pending or it expired. */
export function takePendingFolderName(
  key: string,
  message: string,
  now: number = Date.now(),
): FolderNameOutcome | null {
  const p = pendingFolderCreate.get(key);
  if (!p) return null;
  if (now - p.createdAt > PENDING_FOLDER_TTL_MS) {
    pendingFolderCreate.delete(key);
    return null;
  }
  const text = message.trim();
  if (text === "/cancel") {
    pendingFolderCreate.delete(key);
    return { kind: "cancel" };
  }
  const reason = validateFolderName(text);
  if (reason) return { kind: "invalid", reason }; // keep pending; let them retry
  pendingFolderCreate.delete(key);
  return { kind: "create", name: text, parent: p.parent, onPick: p.onPick };
}
