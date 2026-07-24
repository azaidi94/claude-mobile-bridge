/**
 * Read the model a session is *actually* running from its JSONL transcript.
 *
 * The bot's own `getCurrentModel()` is a process-global default (settings /
 * CLAUDE_MODEL / ~/.claude/settings.json) — it says nothing about the desktop
 * session the user is looking at, which may have been switched with /model or
 * started under a different config. Every assistant entry in the transcript
 * carries the real `message.model`, so the tail of the JSONL is the source of
 * truth.
 *
 * Caveat by construction: this reports the model of the last *completed*
 * assistant turn. A /model switch that hasn't been followed by a reply yet is
 * not visible here — Claude Code records no model-change entry, only the model
 * stamped on each assistant message.
 */

import { debug } from "../logger";
import {
  findSessionJsonlPath,
  findNewestSessionInDir,
  getExpectedJsonlPath,
} from "./tailer";

/** Tail slice scanned for the newest assistant entry. */
const TAIL_BYTES = 512 * 1024;
/**
 * Ceiling for the widen-on-miss retry. Transcripts run to tens of MB and a
 * single line can exceed 1MB (base64 images), so one fixed window isn't enough
 * — but neither is reading a 35MB file to decorate a status line.
 */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

/**
 * Newest main-loop model ID in the session's transcript (e.g. `claude-opus-5`),
 * or null when no transcript is attributable. Sidechain (subagent) entries are
 * skipped — they can run a different model than the main loop — as are
 * synthetic entries, whose model is `<synthetic>`.
 *
 * A `sessionId` that doesn't resolve to a file deliberately does NOT fall
 * through to the directory scan: the newest sibling transcript in the same cwd
 * (a ralph loop, a second session) would yield a confidently wrong model. The
 * dir scan runs only when there's no id at all, and validates its pick as a
 * real transcript rather than one of Claude Code's metadata stubs.
 */
export async function readTranscriptModel(
  sessionId?: string,
  dir?: string,
): Promise<string | null> {
  let filePath: string | null = null;

  if (sessionId) {
    filePath = await findSessionJsonlPath(sessionId);
  } else if (dir) {
    const newest = await findNewestSessionInDir(dir);
    filePath = newest ? getExpectedJsonlPath(dir, newest) : null;
  }

  if (!filePath) {
    debug("transcript-model: no transcript", { session: sessionId, dir });
    return null;
  }

  const model = await readModelFromTail(filePath);
  if (!model) {
    debug("transcript-model: no model in tail", {
      session: sessionId,
      path: filePath,
    });
  }
  return model;
}

/**
 * Scan the tail of a JSONL for the newest main-loop assistant model, widening
 * the window on a miss. A trailing line larger than the window would otherwise
 * be dropped as "truncated" and hide the model entirely.
 */
async function readModelFromTail(filePath: string): Promise<string | null> {
  try {
    const file = Bun.file(filePath);
    const size = file.size;
    if (size === 0) return null;

    for (let window = TAIL_BYTES; ; window *= 4) {
      const start = Math.max(0, size - window);
      const text = await file.slice(start, size).text();
      const lines = text.split("\n").filter(Boolean);
      // Drop the first line when we sliced mid-file — it's likely truncated.
      if (start > 0) lines.shift();

      const model = findModelInLines(lines);
      if (model) return model;
      if (start === 0 || window >= MAX_SCAN_BYTES) return null;
    }
  } catch (err) {
    debug("transcript-model: read failed", {
      path: filePath,
      err: String(err),
    });
    return null;
  }
}

/** Newest-first scan for an assistant entry carrying a real model ID. */
function findModelInLines(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]!) as {
        type?: string;
        isSidechain?: boolean;
        message?: { model?: string };
      };
      if (entry.type !== "assistant" || entry.isSidechain) continue;
      const model = entry.message?.model;
      if (typeof model === "string" && model.startsWith("claude-")) {
        return model;
      }
    } catch {
      // Malformed line — keep scanning backwards
    }
  }
  return null;
}
