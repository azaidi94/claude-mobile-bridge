/**
 * File-based log rotation for the bot's primary log (bot.log).
 *
 * - On startup, if `bot.log` exists non-empty, shift it to `bot.log.1` (and
 *   `bot.log.1` → `bot.log.2`, etc.). Oldest beyond MAX_ARCHIVES is deleted.
 * - On every write, track bytes; when MAX_BYTES is crossed, close stream,
 *   shift archives, open fresh bot.log.
 *
 * One bot.log per process. Call setupBotLogRotation once at startup,
 * BEFORE any log calls.
 */

import {
  createWriteStream,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
  mkdirSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import type { WriteStream } from "fs";

export const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_ARCHIVES = 5;

let currentStream: WriteStream | null = null;
let currentBytes = 0;
let currentPath = "";

function shiftArchives(logPath: string): void {
  const oldest = `${logPath}.${MAX_ARCHIVES}`;
  if (existsSync(oldest)) {
    try {
      unlinkSync(oldest);
    } catch {}
  }
  for (let i = MAX_ARCHIVES - 1; i >= 1; i--) {
    const src = `${logPath}.${i}`;
    const dst = `${logPath}.${i + 1}`;
    if (existsSync(src)) {
      try {
        renameSync(src, dst);
      } catch {}
    }
  }
  if (existsSync(logPath)) {
    try {
      renameSync(logPath, `${logPath}.1`);
    } catch {}
  }
}

function openStream(logPath: string): WriteStream {
  mkdirSync(dirname(logPath), { recursive: true });
  // Ensure the file exists synchronously so callers can stat it immediately.
  if (!existsSync(logPath)) {
    writeFileSync(logPath, "");
  }
  return createWriteStream(logPath, { flags: "a" });
}

export function setupBotLogRotation(logPath: string): void {
  currentPath = logPath;
  if (existsSync(logPath) && statSync(logPath).size > 0) {
    shiftArchives(logPath);
  }
  currentStream = openStream(logPath);
  currentBytes = 0;
}

export function writeToBotLog(line: string): void {
  if (!currentStream || !currentPath) return;
  const buf = Buffer.from(line);
  try {
    currentStream.write(buf);
    currentBytes += buf.length;
  } catch {
    return;
  }
  if (currentBytes >= MAX_BYTES) rotateNow();
}

function rotateNow(): void {
  if (!currentStream || !currentPath) return;
  const oldStream = currentStream;
  const path = currentPath;
  currentStream = null;
  currentBytes = 0;
  try {
    oldStream.end();
  } catch {}
  shiftArchives(path);
  currentStream = openStream(path);
}

export function _forceRotateForTests(): void {
  rotateNow();
}

export function _resetForTests(): void {
  if (currentStream) {
    try {
      currentStream.end();
    } catch {}
  }
  currentStream = null;
  currentBytes = 0;
  currentPath = "";
}

export function _currentBytesForTests(): number {
  return currentBytes;
}
