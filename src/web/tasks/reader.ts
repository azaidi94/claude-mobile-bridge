import { readdir, readFile, stat, open } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import { debug } from "../../logger";
import type { TaskPayload, TaskSession, TasksSnapshot } from "./types";

interface RawTask {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
  blocks?: string[];
  blockedBy?: string[];
}

/** Read first 64 KB of a JSONL to extract session's cwd (project path). */
async function readSessionCwd(jsonlPath: string): Promise<string | null> {
  if (!existsSync(jsonlPath)) return null;
  try {
    const fh = await open(jsonlPath, "r");
    try {
      const { buffer, bytesRead } = await fh.read({
        buffer: Buffer.alloc(65536),
        position: 0,
      });
      const content = buffer.toString("utf8", 0, bytesRead);
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (typeof data.cwd === "string" && data.cwd.length > 0) {
            return data.cwd;
          }
        } catch {
          // malformed line — continue
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

/** Find the JSONL file for a given session id under projects/. */
export async function findSessionJsonl(
  claudeDir: string,
  sessionId: string,
): Promise<string | null> {
  const projectsDir = join(claudeDir, "projects");
  if (!existsSync(projectsDir)) return null;
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(projectsDir, entry.name, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // ignore
  }
  return null;
}

async function resolveSessionMeta(
  claudeDir: string,
  sessionId: string,
  live: boolean,
): Promise<TaskSession> {
  const jsonl = await findSessionJsonl(claudeDir, sessionId);
  if (jsonl) {
    const cwd = await readSessionCwd(jsonl);
    if (cwd) {
      return {
        id: sessionId,
        name: basename(cwd) || sessionId,
        projectDir: cwd,
        live,
      };
    }
  }
  return { id: sessionId, name: sessionId, projectDir: "", live };
}

function toTaskPayload(
  sessionId: string,
  raw: RawTask,
  mtimeMs: number,
): TaskPayload {
  return {
    sessionId,
    id: raw.id,
    subject: raw.subject,
    description: raw.description ?? "",
    status: raw.status,
    updatedAt: mtimeMs,
  };
}

/** Read a single task JSON file. Returns null if malformed or missing. */
export async function readSessionTask(
  sessionId: string,
  filePath: string,
): Promise<TaskPayload | null> {
  try {
    const [buf, st] = await Promise.all([readFile(filePath), stat(filePath)]);
    const raw = JSON.parse(buf.toString("utf8")) as RawTask;
    if (!raw || typeof raw.id !== "string" || typeof raw.subject !== "string") {
      return null;
    }
    return toTaskPayload(sessionId, raw, st.mtimeMs);
  } catch (err) {
    debug("tasks: failed to read task file", {
      filePath,
      err: (err as Error).message,
    });
    return null;
  }
}

/**
 * Scan {claudeDir}/tasks/* and return all sessions + tasks.
 *
 * `liveSessionIds` marks which session dirs belong to a currently-tracked
 * session; the web UI uses it to offer an "active sessions only" filter so
 * task files left behind by long-dead sessions don't clutter the board.
 */
export async function readSnapshot(
  claudeDir: string,
  liveSessionIds: ReadonlySet<string> = new Set(),
): Promise<TasksSnapshot> {
  const tasksDir = join(claudeDir, "tasks");
  if (!existsSync(tasksDir)) return { sessions: [], tasks: [] };

  let sessionDirs: string[];
  try {
    const entries = await readdir(tasksDir, { withFileTypes: true });
    sessionDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { sessions: [], tasks: [] };
  }

  const sessions: TaskSession[] = [];
  const tasks: TaskPayload[] = [];

  for (const sid of sessionDirs) {
    const sDir = join(tasksDir, sid);
    let files: string[] = [];
    try {
      files = (await readdir(sDir)).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    sessions.push(
      await resolveSessionMeta(claudeDir, sid, liveSessionIds.has(sid)),
    );
    for (const f of files) {
      const task = await readSessionTask(sid, join(sDir, f));
      if (task) tasks.push(task);
    }
  }

  return { sessions, tasks };
}
