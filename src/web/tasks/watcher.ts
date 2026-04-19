import chokidar, { type FSWatcher } from "chokidar";
import { EventEmitter } from "events";
import { mkdirSync } from "fs";
import { join, sep, basename, dirname } from "path";
import { warn } from "../../logger";
import { readSessionTask } from "./reader";
import type { TaskStreamEvent } from "./types";

interface WatcherHandle {
  fsWatcher: FSWatcher;
  emitter: EventEmitter;
  subscribers: number;
  readyPromise: Promise<void>;
}

const handles = new Map<string, WatcherHandle>();

function parseSessionAndId(
  tasksDir: string,
  filePath: string,
): { sessionId: string; taskId: string } | null {
  if (!filePath.startsWith(tasksDir)) return null;
  const rel = filePath.slice(tasksDir.length).replace(/^[\\/]/, "");
  const parts = rel.split(sep);
  if (parts.length !== 2) return null;
  const file = parts[1]!;
  if (!file.endsWith(".json")) return null;
  return { sessionId: parts[0]!, taskId: file.slice(0, -".json".length) };
}

function ensureHandle(claudeDir: string): WatcherHandle {
  const existing = handles.get(claudeDir);
  if (existing) return existing;

  const tasksDir = join(claudeDir, "tasks");
  // Make sure the dir exists so chokidar has something to watch on cold start.
  try {
    mkdirSync(tasksDir, { recursive: true });
  } catch {
    // ignore — chokidar error handler will surface real failures
  }

  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  const fsWatcher = chokidar.watch(tasksDir, {
    depth: 2,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    persistent: true,
  });

  const onUpsert = async (filePath: string) => {
    const parsed = parseSessionAndId(tasksDir, filePath);
    if (!parsed) return;
    const task = await readSessionTask(parsed.sessionId, filePath);
    if (!task) return;
    const evt: TaskStreamEvent = {
      type: "task.upsert",
      sessionId: parsed.sessionId,
      task,
    };
    emitter.emit("event", evt);
  };

  fsWatcher.on("add", onUpsert);
  fsWatcher.on("change", onUpsert);

  fsWatcher.on("unlink", (filePath) => {
    const parsed = parseSessionAndId(tasksDir, filePath);
    if (!parsed) return;
    const evt: TaskStreamEvent = {
      type: "task.delete",
      sessionId: parsed.sessionId,
      taskId: parsed.taskId,
    };
    emitter.emit("event", evt);
  });

  fsWatcher.on("unlinkDir", (dirPath) => {
    // Only direct children of tasksDir (session dirs)
    if (dirname(dirPath) !== tasksDir) return;
    const evt: TaskStreamEvent = {
      type: "session.delete",
      sessionId: basename(dirPath),
    };
    emitter.emit("event", evt);
  });

  fsWatcher.on("error", (err) =>
    warn(`tasks watcher error: ${(err as Error).message}`),
  );

  const readyPromise = new Promise<void>((resolve) => {
    fsWatcher.once("ready", () => resolve());
  });

  const handle: WatcherHandle = {
    fsWatcher,
    emitter,
    subscribers: 0,
    readyPromise,
  };
  handles.set(claudeDir, handle);
  return handle;
}

export function subscribe(
  claudeDir: string,
  onEvent: (e: TaskStreamEvent) => void,
): () => void {
  const handle = ensureHandle(claudeDir);
  handle.subscribers += 1;
  handle.emitter.on("event", onEvent);
  return () => {
    handle.emitter.off("event", onEvent);
    handle.subscribers -= 1;
    // Intentionally never teardown — cost is one fs watch; avoids thrash.
  };
}

export function ready(claudeDir: string): Promise<void> {
  const handle = ensureHandle(claudeDir);
  return handle.readyPromise;
}

/** Test helper — fully tear down a watcher so tmpdir can be cleaned. */
export async function __resetForTests(claudeDir?: string): Promise<void> {
  const keys = claudeDir ? [claudeDir] : [...handles.keys()];
  for (const k of keys) {
    const h = handles.get(k);
    if (!h) continue;
    h.emitter.removeAllListeners();
    await h.fsWatcher.close();
    handles.delete(k);
  }
}
