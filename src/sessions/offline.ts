/**
 * Lists offline Claude sessions from ~/.claude/projects/.
 *
 * An "offline" session is a project directory with JSONL history
 * but no live relay process. Returns one entry per working directory,
 * sorted most-recent-first.
 */

import { readdir, stat, open } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { getRelayDirs } from "../relay";
import { getLastSessionMessage } from "./tailer";
import { ALLOWED_PATHS } from "../config";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface OfflineSession {
  /** Decoded working directory (read from JSONL cwd field). */
  dir: string;
  /** Entry name under ~/.claude/projects/ */
  encodedDir: string;
  /** mtime of the newest JSONL file (ms). */
  lastActivity: number;
  /** ~80-char preview of last user or assistant message. */
  lastMessage: string | null;
}

/**
 * Find the most recently modified .jsonl file in a project directory.
 * Exported for unit testing.
 */
export async function findNewestJsonlInDir(
  projectDir: string,
): Promise<{ path: string; mtime: number } | null> {
  let best: { path: string; mtime: number } | null = null;
  try {
    const files = await readdir(projectDir);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(projectDir, file);
      const s = await stat(filePath).catch(() => null);
      if (!s?.isFile()) continue;
      const mtime = s.mtime.getTime();
      if (!best || mtime > best.mtime) {
        best = { path: filePath, mtime };
      }
    }
  } catch {
    // Directory unreadable — skip
  }
  return best;
}

/**
 * Read the `cwd` field from the first JSONL entry that contains it.
 * Some sessions start with a `file-history-snapshot` entry (no cwd) —
 * we scan up to 16 KB to find the first line with a cwd field.
 * Exported for unit testing.
 */
export async function readCwdFromJsonl(
  filePath: string,
): Promise<string | null> {
  try {
    const fh = await open(filePath, "r");
    try {
      const buf = Buffer.alloc(16384);
      const { bytesRead } = await fh.read(buf, 0, 16384, 0);
      if (bytesRead === 0) return null;
      const chunk = buf.toString("utf-8", 0, bytesRead);
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (typeof entry.cwd === "string") return entry.cwd;
        } catch {
          // malformed line — keep scanning
        }
      }
      return null;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/**
 * List offline Claude sessions — one per working directory, most recent first.
 *
 * Filters out:
 * - Directories with a live relay (already shown in /list)
 * - Working directories that no longer exist on disk
 */
export async function listOfflineSessions(): Promise<OfflineSession[]> {
  const [liveRelayDirs, projectEntries] = await Promise.all([
    getRelayDirs(),
    readdir(PROJECTS_DIR).catch((): string[] => []),
  ]);

  const liveSet = new Set(liveRelayDirs);

  const candidates = (
    await Promise.all(
      projectEntries.map(async (entry): Promise<OfflineSession | null> => {
        if (entry.startsWith(".")) return null;

        const projectDir = join(PROJECTS_DIR, entry);
        const newest = await findNewestJsonlInDir(projectDir);
        if (!newest) return null;

        const cwd = await readCwdFromJsonl(newest.path);
        if (!cwd) return null;

        // Skip live sessions
        if (liveSet.has(cwd)) return null;

        // Skip directories that no longer exist on disk
        const dirStat = await stat(cwd).catch(() => null);
        if (!dirStat?.isDirectory()) return null;

        // Only show sessions within allowed paths
        if (!ALLOWED_PATHS.some((p) => cwd.startsWith(p))) return null;

        const lastMsgResult = await getLastSessionMessage(newest.path, 80);

        return {
          dir: cwd,
          encodedDir: entry,
          lastActivity: newest.mtime,
          lastMessage: lastMsgResult?.text ?? null,
        };
      }),
    )
  ).filter((s): s is OfflineSession => s !== null);

  // Deduplicate by working directory — keep the most recent entry per dir
  const seenDirs = new Set<string>();
  const results: OfflineSession[] = [];
  for (const s of candidates.sort((a, b) => b.lastActivity - a.lastActivity)) {
    if (seenDirs.has(s.dir)) continue;
    seenDirs.add(s.dir);
    results.push(s);
  }

  return results;
}
