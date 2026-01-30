/**
 * Session watcher - auto-discovers Claude Code sessions.
 * Uses fs.watch for instant detection + periodic polling as backup.
 */

import { watch, type FSWatcher } from "fs";
import { readdir, stat, readFile, writeFile, unlink } from "fs/promises";
import { join, basename } from "path";
import { homedir, tmpdir } from "os";
import { exec } from "child_process";
import { promisify } from "util";
import type { SessionInfo } from "./types";
import type { SessionDiff } from "./notifications";
import { info, warn, error } from "../logger";

const execAsync = promisify(exec);

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const ACTIVE_SESSION_FILE = join(
  tmpdir(),
  "claude-telegram-active-session.txt",
);
const POLL_INTERVAL_MS = 60_000; // 60s backup poll
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

interface SessionCache {
  sessions: Map<string, SessionInfo>; // keyed by name
  active: string | null;
}

// In-memory cache
const cache: SessionCache = {
  sessions: new Map(),
  active: null,
};

let watcher: FSWatcher | null = null;
let pollInterval: Timer | null = null;
let onChangeCallback: ((diff: SessionDiff) => void) | null = null;
let debounceTimer: Timer | null = null;
const DEBOUNCE_MS = 500;

/**
 * Save active session name to disk for persistence across restarts.
 */
async function saveActiveSession(): Promise<void> {
  try {
    if (cache.active) {
      await writeFile(ACTIVE_SESSION_FILE, cache.active, "utf-8");
    } else {
      await unlink(ACTIVE_SESSION_FILE).catch(() => {});
    }
  } catch {
    // Ignore save errors
  }
}

/**
 * Load active session name from disk.
 */
async function loadActiveSession(): Promise<string | null> {
  try {
    const name = await readFile(ACTIVE_SESSION_FILE, "utf-8");
    return name.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get directories of running Claude Code processes.
 * Only includes processes with a TTY (filters out orphans).
 */
async function getRunningClaudeDirectories(): Promise<Set<string>> {
  const dirs = new Set<string>();
  try {
    // Find claude processes with a TTY (not "??") and get their working directories
    const { stdout } = await execAsync(
      `ps -eo pid,tty,comm | awk '($3 == "claude" || $3 ~ /^[0-9]+\\.[0-9]+\\.[0-9]+$/) && $2 != "??" {print $1}' | xargs -I{} lsof -p {} -a -d cwd -Fn 2>/dev/null | grep "^n" | cut -c2- | sort -u`,
    );
    for (const line of stdout.trim().split("\n")) {
      if (line) dirs.add(line);
    }
  } catch {
    // No claude processes running
  }
  return dirs;
}

/**
 * Parse a session JSONL file to extract session info.
 */
async function parseSessionFile(
  filePath: string,
): Promise<{ sessionId: string; cwd: string } | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean).slice(0, 100);

    let sessionId: string | null = null;
    let cwd: string | null = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
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

    return sessionId && cwd ? { sessionId, cwd } : null;
  } catch {
    return null;
  }
}

/**
 * Check if string is valid UUID.
 */
function isUuid(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    str,
  );
}

/**
 * Generate unique session name from directory.
 */
function generateName(dir: string): string {
  const base = basename(dir) || "session";

  if (!cache.sessions.has(base)) {
    return base;
  }

  let suffix = 2;
  while (cache.sessions.has(`${base}-${suffix}`)) {
    suffix++;
  }
  return `${base}-${suffix}`;
}

/**
 * Scan ~/.claude/projects for sessions.
 * Only returns sessions with running Claude Code processes.
 */
async function scanSessions(): Promise<SessionInfo[]> {
  const found: SessionInfo[] = [];

  // Get directories with running Claude processes
  const runningDirs = await getRunningClaudeDirectories();
  if (runningDirs.size === 0) {
    return found;
  }

  const mostRecentByDir: Map<string, { info: SessionInfo; mtime: number }> =
    new Map();

  try {
    const projects = await readdir(PROJECTS_DIR);

    for (const project of projects) {
      if (project.startsWith(".")) continue;

      const projectPath = join(PROJECTS_DIR, project);
      const projectStat = await stat(projectPath).catch(() => null);
      if (!projectStat?.isDirectory()) continue;

      const files = await readdir(projectPath);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;

        const sessionId = file.replace(".jsonl", "");
        if (!isUuid(sessionId)) continue;

        const filePath = join(projectPath, file);
        const fileStat = await stat(filePath).catch(() => null);
        if (!fileStat) continue;

        const mtime = fileStat.mtime?.getTime() || 0;

        // Skip sessions older than 24h
        if (Date.now() - mtime > MAX_AGE_MS) continue;

        const parsed = await parseSessionFile(filePath);
        if (!parsed) continue;

        // Only include if Claude is running in this directory
        if (!runningDirs.has(parsed.cwd)) continue;

        const existing = mostRecentByDir.get(parsed.cwd);
        if (!existing || mtime > existing.mtime) {
          mostRecentByDir.set(parsed.cwd, {
            info: {
              id: parsed.sessionId,
              name: "", // Generated later
              dir: parsed.cwd,
              lastActivity: mtime,
              source: "desktop",
            },
            mtime,
          });
        }
      }
    }
  } catch (err) {
    error(`scan: ${err}`);
  }

  for (const { info } of mostRecentByDir.values()) {
    found.push(info);
  }

  return found;
}

/**
 * Refresh the session cache. Returns diff of desktop sessions.
 */
async function refresh(): Promise<SessionDiff> {
  // Snapshot current desktop sessions by dir
  const oldDesktop = new Map<string, { name: string; dir: string }>();
  for (const s of cache.sessions.values()) {
    if (s.source === "desktop") {
      oldDesktop.set(s.dir, { name: s.name, dir: s.dir });
    }
  }

  const discovered = await scanSessions();

  // Keep telegram sessions, replace discovered ones
  const telegramSessions: SessionInfo[] = [];
  for (const s of cache.sessions.values()) {
    if (s.source === "telegram") {
      // Keep if active in last 24h
      if (Date.now() - s.lastActivity < MAX_AGE_MS) {
        telegramSessions.push(s);
      }
    }
  }

  // Rebuild cache
  cache.sessions.clear();

  // Add discovered sessions with generated names
  for (const si of discovered) {
    si.name = generateName(si.dir);
    cache.sessions.set(si.name, si);
  }

  // Add telegram sessions back
  for (const si of telegramSessions) {
    // Re-generate name in case of conflict
    if (cache.sessions.has(si.name)) {
      si.name = generateName(si.dir);
    }
    cache.sessions.set(si.name, si);
  }

  // Compute diff
  const newDesktopDirs = new Set<string>();
  for (const s of cache.sessions.values()) {
    if (s.source === "desktop") newDesktopDirs.add(s.dir);
  }

  const added: SessionInfo[] = [];
  for (const s of cache.sessions.values()) {
    if (s.source === "desktop" && !oldDesktop.has(s.dir)) {
      added.push(s);
    }
  }

  const removed: { name: string; dir: string }[] = [];
  for (const [dir, old] of oldDesktop) {
    if (!newDesktopDirs.has(dir)) {
      removed.push(old);
    }
  }

  // Validate active session
  if (cache.active && !cache.sessions.has(cache.active)) {
    cache.active = null;
  }

  // Auto-select if none active
  if (!cache.active && cache.sessions.size > 0) {
    // Try to restore persisted active session
    const persisted = await loadActiveSession();
    if (persisted && cache.sessions.has(persisted)) {
      cache.active = persisted;
    } else {
      // Pick most recent
      let mostRecent: SessionInfo | null = null;
      for (const s of cache.sessions.values()) {
        if (!mostRecent || s.lastActivity > mostRecent.lastActivity) {
          mostRecent = s;
        }
      }
      if (mostRecent) {
        cache.active = mostRecent.name;
      }
    }
  }

  return { added, removed };
}

/**
 * Start watching for session changes.
 */
export async function startWatcher(
  onChange?: (diff: SessionDiff) => void,
): Promise<void> {
  onChangeCallback = onChange || null;

  // Initial scan (no notifications on startup)
  await refresh();
  info(
    `watcher: ${cache.sessions.size} session${cache.sessions.size !== 1 ? "s" : ""}`,
  );

  // Start fs.watch on projects directory
  try {
    watcher = watch(PROJECTS_DIR, { recursive: true }, (event, filename) => {
      // Only trigger on file creation/deletion ('rename'), not content changes ('change')
      if (event === "rename" && filename?.endsWith(".jsonl")) {
        // Debounce rapid events
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          const diff = await refresh();
          if (diff.added.length || diff.removed.length) {
            onChangeCallback?.(diff);
          }
        }, DEBOUNCE_MS);
      }
    });
    info(`watcher: watching ${PROJECTS_DIR}`);
  } catch (err) {
    warn(`watcher: fs.watch failed, polling only: ${err}`);
  }

  // Backup polling
  pollInterval = setInterval(async () => {
    const diff = await refresh();
    if (diff.added.length || diff.removed.length) {
      onChangeCallback?.(diff);
    }
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the watcher.
 */
export function stopWatcher(): void {
  watcher?.close();
  watcher = null;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

/**
 * Force immediate refresh.
 */
export async function forceRefresh(): Promise<void> {
  await refresh();
}

/**
 * Get all sessions.
 */
export function getSessions(): SessionInfo[] {
  return Array.from(cache.sessions.values()).sort(
    (a, b) => b.lastActivity - a.lastActivity,
  );
}

/**
 * Get active session.
 */
export function getActiveSession(): { name: string; info: SessionInfo } | null {
  if (!cache.active) return null;
  const info = cache.sessions.get(cache.active);
  if (!info) return null;
  return { name: cache.active, info };
}

/**
 * Set active session by name.
 */
export function setActiveSession(name: string): boolean {
  if (!cache.sessions.has(name)) return false;
  cache.active = name;
  saveActiveSession(); // persist
  return true;
}

/**
 * Get session by name.
 */
export function getSession(name: string): SessionInfo | null {
  return cache.sessions.get(name) || null;
}

/**
 * Add a telegram-created session.
 */
export function addTelegramSession(
  dir: string,
  explicitName?: string,
): SessionInfo {
  const name = explicitName?.trim() || generateName(dir);

  const info: SessionInfo = {
    id: "", // Set when first message sent
    name,
    dir,
    lastActivity: Date.now(),
    source: "telegram",
  };

  cache.sessions.set(name, info);
  cache.active = name;
  saveActiveSession(); // persist

  return info;
}

/**
 * Update session ID (after first message creates Claude session).
 */
export function updateSessionId(name: string, sessionId: string): void {
  const info = cache.sessions.get(name);
  if (info) {
    info.id = sessionId;
    info.lastActivity = Date.now();
  }
}

/**
 * Update session activity timestamp.
 */
export function updateSessionActivity(name: string): void {
  const info = cache.sessions.get(name);
  if (info) {
    info.lastActivity = Date.now();
  }
}

/**
 * Remove a session from the cache.
 */
export function removeSession(name: string): boolean {
  const deleted = cache.sessions.delete(name);
  if (deleted && cache.active === name) {
    cache.active = null;
    saveActiveSession();
  }
  return deleted;
}
