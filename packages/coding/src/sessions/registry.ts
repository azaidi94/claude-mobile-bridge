/**
 * Session registry for multi-session management.
 * Stores sessions in ~/.claude-bridge/sessions.json
 */

import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
import type { SessionInfo, SessionRegistry, SessionListItem } from "./types";

const REGISTRY_DIR = join(homedir(), ".claude-bridge");
const REGISTRY_FILE = join(REGISTRY_DIR, "sessions.json");

// Session considered stale after 7 days of inactivity
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

async function ensureRegistryDir(): Promise<void> {
  await mkdir(REGISTRY_DIR, { recursive: true });
}

export async function loadRegistry(): Promise<SessionRegistry> {
  try {
    const data = await readFile(REGISTRY_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return { sessions: {}, active: null };
  }
}

export async function saveRegistry(registry: SessionRegistry): Promise<void> {
  await ensureRegistryDir();
  await writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

/**
 * Check if session's JSONL file still exists in ~/.claude/projects
 */
export async function sessionFileExists(sessionId: string): Promise<boolean> {
  const projectsDir = join(homedir(), ".claude", "projects");
  try {
    const { readdir } = await import("fs/promises");
    const projects = await readdir(projectsDir);

    for (const project of projects) {
      if (project.startsWith(".")) continue;
      const projectPath = join(projectsDir, project);
      const projectStat = await stat(projectPath).catch(() => null);
      if (!projectStat?.isDirectory()) continue;

      const sessionFile = join(projectPath, `${sessionId}.jsonl`);
      const exists = await stat(sessionFile).catch(() => null);
      if (exists) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function registerSession(info: SessionInfo): Promise<void> {
  const registry = await loadRegistry();
  registry.sessions[info.name] = info;

  // If no active session, make this one active
  if (!registry.active) {
    registry.active = info.name;
  }
  await saveRegistry(registry);
}

export async function unregisterSession(name: string): Promise<void> {
  const registry = await loadRegistry();
  delete registry.sessions[name];

  // If we deleted the active session, pick another
  if (registry.active === name) {
    const remaining = Object.keys(registry.sessions);
    registry.active = remaining.length > 0 ? (remaining[0] ?? null) : null;
  }
  await saveRegistry(registry);
}

export async function getActiveSession(): Promise<{ name: string; info: SessionInfo } | null> {
  const registry = await loadRegistry();
  if (!registry.active) {
    return null;
  }
  const info = registry.sessions[registry.active];
  if (!info) {
    return null;
  }
  return { name: registry.active, info };
}

export async function setActiveSession(name: string): Promise<boolean> {
  const registry = await loadRegistry();
  if (!registry.sessions[name]) {
    return false;
  }
  registry.active = name;
  await saveRegistry(registry);
  return true;
}

export async function updateSessionActivity(name: string): Promise<void> {
  const registry = await loadRegistry();
  if (registry.sessions[name]) {
    registry.sessions[name].lastActivity = Date.now();
    await saveRegistry(registry);
  }
}

export async function updateSessionId(name: string, newId: string): Promise<void> {
  const registry = await loadRegistry();
  if (registry.sessions[name]) {
    registry.sessions[name].id = newId;
    registry.sessions[name].lastActivity = Date.now();
    await saveRegistry(registry);
  }
}

/**
 * Generate a unique session name from directory path.
 */
export async function generateName(dir: string, explicitName?: string): Promise<string> {
  const registry = await loadRegistry();

  // Use explicit name if provided
  if (explicitName && explicitName.trim()) {
    const name = explicitName.trim();
    if (!registry.sessions[name]) {
      return name;
    }
    // Add suffix for conflicts
    let suffix = 2;
    while (registry.sessions[`${name}-${suffix}`]) {
      suffix++;
    }
    return `${name}-${suffix}`;
  }

  // Generate from directory basename
  const base = basename(dir) || "session";

  if (!registry.sessions[base]) {
    return base;
  }

  let suffix = 2;
  while (registry.sessions[`${base}-${suffix}`]) {
    suffix++;
  }
  return `${base}-${suffix}`;
}

/**
 * List all sessions with alive status.
 */
export async function listSessions(): Promise<SessionListItem[]> {
  const registry = await loadRegistry();
  const results: SessionListItem[] = [];

  for (const [name, info] of Object.entries(registry.sessions)) {
    const alive = await sessionFileExists(info.id);
    results.push({
      name,
      info,
      alive,
      isActive: name === registry.active,
    });
  }

  // Sort by last activity (most recent first)
  results.sort((a, b) => b.info.lastActivity - a.info.lastActivity);

  return results;
}

/**
 * Remove sessions whose JSONL files no longer exist.
 */
export async function cleanupDeadSessions(): Promise<string[]> {
  const registry = await loadRegistry();
  const removed: string[] = [];

  for (const [name, info] of Object.entries(registry.sessions)) {
    const alive = await sessionFileExists(info.id);
    if (!alive) {
      delete registry.sessions[name];
      removed.push(name);
    }
  }

  // Update active if it was removed
  if (registry.active && !registry.sessions[registry.active]) {
    const remaining = Object.keys(registry.sessions);
    registry.active = remaining.length > 0 ? (remaining[0] ?? null) : null;
  }

  if (removed.length > 0) {
    await saveRegistry(registry);
  }

  return removed;
}

/**
 * Remove sessions that haven't been used in over a week.
 */
export async function cleanupStaleSessions(): Promise<string[]> {
  const registry = await loadRegistry();
  const removed: string[] = [];
  const now = Date.now();

  for (const [name, info] of Object.entries(registry.sessions)) {
    const age = now - info.lastActivity;
    if (age > STALE_THRESHOLD_MS) {
      delete registry.sessions[name];
      removed.push(name);
    }
  }

  // Update active if it was removed
  if (registry.active && !registry.sessions[registry.active]) {
    const remaining = Object.keys(registry.sessions);
    registry.active = remaining.length > 0 ? (remaining[0] ?? null) : null;
  }

  if (removed.length > 0) {
    await saveRegistry(registry);
  }

  return removed;
}

/**
 * Get session by name.
 */
export async function getSession(name: string): Promise<SessionInfo | null> {
  const registry = await loadRegistry();
  return registry.sessions[name] || null;
}
