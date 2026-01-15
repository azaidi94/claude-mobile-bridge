/**
 * Session discovery - finds Claude Code sessions started from desktop.
 * Scans session JSONL files in ~/.claude/projects
 */

import { readdir, stat, readFile } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
import type { SessionInfo } from "./types";
import { loadRegistry, generateName, registerSession } from "./registry";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

// Only discover sessions active in the last 24 hours
const DISCOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface JsonlEntry {
  sessionId?: string;
  cwd?: string;
  type?: string;
  timestamp?: string;
}

/**
 * Parse a JSONL file to extract session info.
 * Reads first few lines to find sessionId and cwd.
 */
async function parseSessionFile(filePath: string): Promise<{ sessionId: string; cwd: string } | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean).slice(0, 20);

    let sessionId: string | null = null;
    let cwd: string | null = null;

    for (const line of lines) {
      try {
        const entry: JsonlEntry = JSON.parse(line);
        // Skip entries with null values
        if (entry.sessionId && entry.sessionId !== "null" && !sessionId) {
          sessionId = entry.sessionId;
        }
        if (entry.cwd && entry.cwd !== "null" && !cwd) {
          cwd = entry.cwd;
        }
        if (sessionId && cwd) break;
      } catch {
        // Skip malformed lines
      }
    }

    if (sessionId && cwd) {
      return { sessionId, cwd };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a string is a valid UUID.
 */
function isUuid(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

/**
 * Discover Claude Code sessions from disk.
 * Returns only the MOST RECENT session per project directory.
 */
export async function discoverDesktopSessions(): Promise<SessionInfo[]> {
  const discovered: SessionInfo[] = [];
  const registry = await loadRegistry();

  // Get all known session IDs
  const knownIds = new Set(
    Object.values(registry.sessions).map((s) => s.id)
  );

  // Track most recent session per project
  const mostRecentByProject: Map<string, { info: SessionInfo; mtime: number }> = new Map();

  try {
    const projects = await readdir(PROJECTS_DIR);

    for (const project of projects) {
      if (project.startsWith(".")) continue;

      const projectPath = join(PROJECTS_DIR, project);
      const projectStat = await stat(projectPath).catch(() => null);
      if (!projectStat?.isDirectory()) continue;

      // Find .jsonl files directly in project dir (not subdirs)
      const files = await readdir(projectPath);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;

        const sessionId = file.replace(".jsonl", "");
        if (!isUuid(sessionId)) continue;

        // Skip if already known
        if (knownIds.has(sessionId)) continue;

        const filePath = join(projectPath, file);
        const fileStat = await stat(filePath).catch(() => null);
        if (!fileStat) continue;

        const mtime = fileStat.mtime?.getTime() || 0;

        // Skip sessions older than 24h
        if (Date.now() - mtime > DISCOVERY_MAX_AGE_MS) continue;

        const parsed = await parseSessionFile(filePath);

        if (parsed) {
          const existing = mostRecentByProject.get(project);

          // Only keep if more recent than existing
          if (!existing || mtime > existing.mtime) {
            mostRecentByProject.set(project, {
              info: {
                id: parsed.sessionId,
                name: "", // Will be generated
                dir: parsed.cwd,
                lastActivity: mtime,
                source: "desktop",
              },
              mtime,
            });
          }
        }
      }
    }
  } catch (error) {
    console.error("Error discovering sessions:", error);
  }

  // Return only the most recent session per project
  for (const { info } of mostRecentByProject.values()) {
    discovered.push(info);
  }

  return discovered;
}

/**
 * Discover and register desktop sessions.
 * Returns count of newly registered sessions.
 */
export async function discoverAndRegister(): Promise<{ registered: string[]; skipped: number }> {
  const discovered = await discoverDesktopSessions();
  const registered: string[] = [];
  let skipped = 0;

  for (const session of discovered) {
    try {
      const name = await generateName(session.dir);
      session.name = name;
      await registerSession(session);
      registered.push(name);
    } catch {
      skipped++;
    }
  }

  return { registered, skipped };
}

/**
 * Get project directory name from path (encoded format).
 * /Users/ali/Dev/foo -> -Users-ali-Dev-foo
 */
export function encodeProjectPath(path: string): string {
  return path.replace(/\//g, "-");
}

/**
 * Decode project directory name to path.
 * -Users-ali-Dev-foo -> /Users/ali/Dev/foo
 */
export function decodeProjectPath(encoded: string): string {
  return encoded.replace(/^-/, "/").replace(/-/g, "/");
}
