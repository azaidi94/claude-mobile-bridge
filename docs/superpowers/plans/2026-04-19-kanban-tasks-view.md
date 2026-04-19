# Kanban Tasks View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Tasks" tab to the bridge Mini App that shows Claude Code's task state as a live-updating kanban board, per-session and across all sessions.

**Architecture:** Backend `chokidar` watcher on `~/.claude/tasks/` feeds a broadcast `EventEmitter`; new Hono route `GET /api/tasks` returns a snapshot and `GET /api/tasks/stream` streams upsert/delete events over SSE. Frontend adds a `TasksPage` with a horizontal-scroll (mobile) / 3-column-grid (desktop) `KanbanBoard`, a session selector pill, and a detail sheet that hands off to the existing chat flow.

**Tech Stack:** Bun, TypeScript, Hono, chokidar, React 18, Vite, Tailwind CSS v3, Vitest (new — for frontend tests)

**Spec:** [`docs/superpowers/specs/2026-04-19-kanban-tasks-view-design.md`](../specs/2026-04-19-kanban-tasks-view-design.md)

---

## File Map

**New backend files:**

- `src/web/tasks/reader.ts` — pure functions: list session dirs, read task JSONs, read session metadata from JSONL
- `src/web/tasks/watcher.ts` — module-scope `chokidar` watcher + broadcast `EventEmitter`
- `src/web/tasks/types.ts` — `TaskSession`, `TaskPayload`, `TaskStreamEvent`
- `src/web/routes/tasks.ts` — Hono router: `GET /`, `GET /stream`

**Modified backend files:**

- `src/config.ts` — export `CLAUDE_DIR` (default `~/.claude`, env override `CLAUDE_DIR`)
- `src/web/server.ts` — mount `createTasksRouter()` under `/api/tasks`
- `package.json` — add `chokidar` dependency

**New backend test files:**

- `src/__tests__/web-tasks-reader.test.ts`
- `src/__tests__/web-tasks-watcher.test.ts`
- `src/__tests__/web-tasks-route.test.ts`

**New frontend files:**

- `web/src/pages/TasksPage.tsx`
- `web/src/components/KanbanBoard.tsx`
- `web/src/components/KanbanCard.tsx`
- `web/src/components/TaskDetailSheet.tsx`
- `web/src/__tests__/KanbanBoard.test.tsx`
- `web/vitest.config.ts` — vitest + jsdom setup
- `web/src/test-setup.ts` — testing-library jest-dom matchers

**Modified frontend files:**

- `web/src/api.ts` — add `TaskSession`, `TaskPayload`, `TaskStreamEvent`, `api.getTasks`, `api.streamTasks`
- `web/src/App.tsx` — add `"tasks"` to `Tab` union, render `<TasksPage onSwitchToChat={...} />`
- `web/src/components/BottomNav.tsx` — add Tasks entry to `TABS`, widen `Tab` type
- `web/package.json` — add vitest, jsdom, `@testing-library/react`, `@testing-library/jest-dom`

---

## Task 1: Add `CLAUDE_DIR` config + install `chokidar`

**Files:**

- Modify: `src/config.ts`
- Modify: `package.json`

- [ ] **Step 1: Install chokidar**

```bash
bun add chokidar
```

Expected: `chokidar` appears in `dependencies` in `package.json`, lockfile updates.

- [ ] **Step 2: Add `CLAUDE_DIR` to config**

Open `src/config.ts`. After the `HOME` constant (around line 15), add:

```ts
// ============== Claude Data Directory ==============

/**
 * Root Claude Code data dir. Tasks are under `{CLAUDE_DIR}/tasks/{session-uuid}/`,
 * session JSONLs under `{CLAUDE_DIR}/projects/{encodedDir}/{uuid}.jsonl`.
 * Override via env `CLAUDE_DIR` (primarily for tests).
 */
export const CLAUDE_DIR = process.env.CLAUDE_DIR || `${HOME}/.claude`;
```

- [ ] **Step 3: Typecheck + commit**

```bash
bun run typecheck
```

Expected: no errors.

```bash
git add src/config.ts package.json bun.lock
git commit -m "feat(config): add CLAUDE_DIR export and chokidar dependency"
```

---

## Task 2: Task reader — types + pure functions

**Files:**

- Create: `src/web/tasks/types.ts`
- Create: `src/web/tasks/reader.ts`
- Create: `src/__tests__/web-tasks-reader.test.ts`

- [ ] **Step 1: Write types**

Create `src/web/tasks/types.ts`:

```ts
export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskSession {
  id: string; // session uuid (directory name under tasks/)
  name: string; // human name (slug from jsonl, else last segment of projectDir)
  projectDir: string; // decoded absolute path, or empty if unknown
}

export interface TaskPayload {
  sessionId: string;
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  updatedAt: number; // ms epoch (file mtime)
}

export type TaskStreamEvent =
  | { type: "task.upsert"; sessionId: string; task: TaskPayload }
  | { type: "task.delete"; sessionId: string; taskId: string }
  | { type: "session.delete"; sessionId: string };

export interface TasksSnapshot {
  sessions: TaskSession[];
  tasks: TaskPayload[];
}
```

- [ ] **Step 2: Write the failing reader tests**

Create `src/__tests__/web-tasks-reader.test.ts`:

```ts
import "./ensure-test-env";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "tasks-reader-"));
  process.env.CLAUDE_DIR = TMP;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.CLAUDE_DIR;
});

async function loadReader() {
  return import("../web/tasks/reader");
}

describe("readSnapshot", () => {
  test("returns empty snapshot when tasks dir does not exist", async () => {
    const { readSnapshot } = await loadReader();
    const snap = await readSnapshot(TMP);
    expect(snap).toEqual({ sessions: [], tasks: [] });
  });

  test("reads tasks from a session directory", async () => {
    const sid = "aaaa1111-2222-3333-4444-555566667777";
    const dir = join(TMP, "tasks", sid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "First task",
        description: "desc",
        activeForm: "Doing first task",
        status: "pending",
        blocks: [],
        blockedBy: [],
      }),
    );
    writeFileSync(
      join(dir, "2.json"),
      JSON.stringify({
        id: "2",
        subject: "Second task",
        description: "",
        activeForm: "",
        status: "completed",
        blocks: [],
        blockedBy: [],
      }),
    );

    const { readSnapshot } = await loadReader();
    const snap = await readSnapshot(TMP);
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0]!.id).toBe(sid);
    expect(snap.tasks).toHaveLength(2);
    expect(snap.tasks.map((t) => t.subject).sort()).toEqual([
      "First task",
      "Second task",
    ]);
    expect(snap.tasks[0]!.updatedAt).toBeGreaterThan(0);
  });

  test("skips malformed JSON without throwing", async () => {
    const sid = "bbbb1111-2222-3333-4444-555566667777";
    const dir = join(TMP, "tasks", sid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1.json"), "not json {");
    writeFileSync(
      join(dir, "2.json"),
      JSON.stringify({
        id: "2",
        subject: "Good",
        description: "",
        activeForm: "",
        status: "pending",
        blocks: [],
        blockedBy: [],
      }),
    );

    const { readSnapshot } = await loadReader();
    const snap = await readSnapshot(TMP);
    expect(snap.tasks).toHaveLength(1);
    expect(snap.tasks[0]!.subject).toBe("Good");
  });

  test("derives session name from project jsonl cwd", async () => {
    const sid = "cccc1111-2222-3333-4444-555566667777";
    const encoded = "-Users-test-my-project";
    const tasksDir = join(TMP, "tasks", sid);
    const projectsDir = join(TMP, "projects", encoded);
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(
      join(tasksDir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "x",
        description: "",
        activeForm: "",
        status: "pending",
        blocks: [],
        blockedBy: [],
      }),
    );
    writeFileSync(
      join(projectsDir, `${sid}.jsonl`),
      JSON.stringify({
        type: "user",
        cwd: "/Users/test/my-project",
        message: { role: "user", content: "hi" },
      }) + "\n",
    );

    const { readSnapshot } = await loadReader();
    const snap = await readSnapshot(TMP);
    expect(snap.sessions[0]!.name).toBe("my-project");
    expect(snap.sessions[0]!.projectDir).toBe("/Users/test/my-project");
  });
});

describe("readSessionTask", () => {
  test("parses a single task JSON file", async () => {
    const sid = "dddd1111-2222-3333-4444-555566667777";
    const dir = join(TMP, "tasks", sid);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "1.json");
    writeFileSync(
      file,
      JSON.stringify({
        id: "1",
        subject: "Read me",
        description: "long desc",
        activeForm: "Reading",
        status: "in_progress",
        blocks: [],
        blockedBy: [],
      }),
    );

    const { readSessionTask } = await loadReader();
    const task = await readSessionTask(sid, file);
    expect(task).not.toBeNull();
    expect(task!.id).toBe("1");
    expect(task!.subject).toBe("Read me");
    expect(task!.status).toBe("in_progress");
    expect(task!.sessionId).toBe(sid);
  });

  test("returns null for malformed file", async () => {
    const sid = "eeee1111-2222-3333-4444-555566667777";
    const dir = join(TMP, "tasks", sid);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "1.json");
    writeFileSync(file, "broken");

    const { readSessionTask } = await loadReader();
    const task = await readSessionTask(sid, file);
    expect(task).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests — verify they fail**

```bash
bun test src/__tests__/web-tasks-reader.test.ts
```

Expected: FAIL (`Cannot find module '../web/tasks/reader'`).

- [ ] **Step 4: Implement the reader**

Create `src/web/tasks/reader.ts`:

```ts
import { readdir, readFile, stat, open } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import { warn } from "../../logger";
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
async function findSessionJsonl(
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
): Promise<TaskSession> {
  const jsonl = await findSessionJsonl(claudeDir, sessionId);
  if (jsonl) {
    const cwd = await readSessionCwd(jsonl);
    if (cwd) {
      return {
        id: sessionId,
        name: basename(cwd) || sessionId,
        projectDir: cwd,
      };
    }
  }
  return { id: sessionId, name: sessionId, projectDir: "" };
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
    warn(`tasks: failed to read ${filePath}: ${(err as Error).message}`);
    return null;
  }
}

/** Scan {claudeDir}/tasks/* and return all sessions + tasks. */
export async function readSnapshot(claudeDir: string): Promise<TasksSnapshot> {
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

    sessions.push(await resolveSessionMeta(claudeDir, sid));
    for (const f of files) {
      const task = await readSessionTask(sid, join(sDir, f));
      if (task) tasks.push(task);
    }
  }

  return { sessions, tasks };
}
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
bun test src/__tests__/web-tasks-reader.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/web/tasks/ src/__tests__/web-tasks-reader.test.ts
git commit -m "feat(tasks): add reader for Claude Code task JSONs and session metadata"
```

---

## Task 3: Task watcher — broadcast event bus

**Files:**

- Create: `src/web/tasks/watcher.ts`
- Create: `src/__tests__/web-tasks-watcher.test.ts`

- [ ] **Step 1: Write the failing watcher tests**

Create `src/__tests__/web-tasks-watcher.test.ts`:

```ts
import "./ensure-test-env";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "tasks-watcher-"));
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

async function loadWatcher() {
  return import("../web/tasks/watcher");
}

function waitFor<T>(check: () => T | undefined, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const i = setInterval(() => {
      const v = check();
      if (v !== undefined) {
        clearInterval(i);
        resolve(v);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(i);
        reject(new Error("timeout"));
      }
    }, 25);
  });
}

describe("tasks watcher", () => {
  test("emits task.upsert when a new task file is added", async () => {
    mkdirSync(join(TMP, "tasks"), { recursive: true });
    const { subscribe } = await loadWatcher();
    const events: any[] = [];
    const unsub = subscribe(TMP, (e) => events.push(e));

    const sid = "ffff1111-2222-3333-4444-555566667777";
    const sDir = join(TMP, "tasks", sid);
    mkdirSync(sDir, { recursive: true });
    writeFileSync(
      join(sDir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "hello",
        description: "",
        activeForm: "",
        status: "pending",
        blocks: [],
        blockedBy: [],
      }),
    );

    const upsert = await waitFor(() =>
      events.find((e) => e.type === "task.upsert"),
    );
    expect(upsert.sessionId).toBe(sid);
    expect(upsert.task.subject).toBe("hello");
    unsub();
  });

  test("emits task.delete when a task file is unlinked", async () => {
    const sid = "gggg1111-2222-3333-4444-555566667777";
    const sDir = join(TMP, "tasks", sid);
    mkdirSync(sDir, { recursive: true });
    const file = join(sDir, "1.json");
    writeFileSync(
      file,
      JSON.stringify({
        id: "1",
        subject: "x",
        description: "",
        activeForm: "",
        status: "pending",
        blocks: [],
        blockedBy: [],
      }),
    );

    const { subscribe } = await loadWatcher();
    const events: any[] = [];
    const unsub = subscribe(TMP, (e) => events.push(e));

    // Let the watcher settle on initial scan
    await new Promise((r) => setTimeout(r, 250));
    unlinkSync(file);

    const del = await waitFor(() =>
      events.find((e) => e.type === "task.delete"),
    );
    expect(del.sessionId).toBe(sid);
    expect(del.taskId).toBe("1");
    unsub();
  });

  test("emits session.delete when a session dir is removed", async () => {
    const sid = "hhhh1111-2222-3333-4444-555566667777";
    const sDir = join(TMP, "tasks", sid);
    mkdirSync(sDir, { recursive: true });

    const { subscribe } = await loadWatcher();
    const events: any[] = [];
    const unsub = subscribe(TMP, (e) => events.push(e));

    await new Promise((r) => setTimeout(r, 250));
    rmdirSync(sDir);

    const del = await waitFor(() =>
      events.find((e) => e.type === "session.delete"),
    );
    expect(del.sessionId).toBe(sid);
    unsub();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
bun test src/__tests__/web-tasks-watcher.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement the watcher**

Create `src/web/tasks/watcher.ts`:

```ts
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

  const handle: WatcherHandle = { fsWatcher, emitter, subscribers: 0 };
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
```

- [ ] **Step 4: Wire test cleanup**

Update `src/__tests__/web-tasks-watcher.test.ts` — add to `afterEach` (replace the block):

```ts
afterEach(async () => {
  const { __resetForTests } = await import("../web/tasks/watcher");
  await __resetForTests();
  rmSync(TMP, { recursive: true, force: true });
});
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
bun test src/__tests__/web-tasks-watcher.test.ts
```

Expected: all three tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/web/tasks/watcher.ts src/__tests__/web-tasks-watcher.test.ts
git commit -m "feat(tasks): add chokidar watcher with broadcast event bus"
```

---

## Task 4: Tasks route + server wiring

**Files:**

- Create: `src/web/routes/tasks.ts`
- Modify: `src/web/server.ts`
- Create: `src/__tests__/web-tasks-route.test.ts`

- [ ] **Step 1: Write the failing route tests**

Create `src/__tests__/web-tasks-route.test.ts`:

```ts
import "./ensure-test-env";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";

let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "tasks-route-"));
  process.env.CLAUDE_DIR = TMP;
  process.env.WEB_AUTH_BYPASS = "true";
});

afterEach(async () => {
  const { __resetForTests } = await import("../web/tasks/watcher");
  await __resetForTests();
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.CLAUDE_DIR;
  delete process.env.WEB_AUTH_BYPASS;
});

async function buildApp() {
  const { createTasksRouter } = await import("../web/routes/tasks");
  const app = new Hono();
  app.route("/api/tasks", createTasksRouter());
  return app;
}

describe("GET /api/tasks", () => {
  test("returns empty snapshot when tasks dir is missing", async () => {
    const app = await buildApp();
    const res = await app.request("/api/tasks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ sessions: [], tasks: [] });
  });

  test("returns sessions + tasks from fixture", async () => {
    const sid = "iiii1111-2222-3333-4444-555566667777";
    const d = join(TMP, "tasks", sid);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "a",
        description: "",
        activeForm: "",
        status: "pending",
        blocks: [],
        blockedBy: [],
      }),
    );

    const app = await buildApp();
    const res = await app.request("/api/tasks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{ id: string }>;
      tasks: Array<{ subject: string }>;
    };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.id).toBe(sid);
    expect(body.tasks.map((t) => t.subject)).toEqual(["a"]);
  });
});

describe("GET /api/tasks/stream", () => {
  test("opens an SSE stream with content-type text/event-stream", async () => {
    const app = await buildApp();
    const res = await app.request("/api/tasks/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    // cancel to let watcher tear down cleanly
    await res.body?.cancel();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
bun test src/__tests__/web-tasks-route.test.ts
```

Expected: FAIL (`Cannot find module '../web/routes/tasks'`).

- [ ] **Step 3: Implement the route**

Create `src/web/routes/tasks.ts`:

```ts
import { Hono } from "hono";
import { authMiddleware } from "../auth";
import { readSnapshot } from "../tasks/reader";
import { subscribe } from "../tasks/watcher";

function getClaudeDir(): string {
  // Read dynamically so tests that set CLAUDE_DIR after config load still work.
  return process.env.CLAUDE_DIR || `${process.env.HOME}/.claude`;
}

export function createTasksRouter(): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/", async (c) => {
    const snapshot = await readSnapshot(getClaudeDir());
    return c.json(snapshot);
  });

  app.get("/stream", (c) => {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array>;

    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        controller = ctrl;
        ctrl.enqueue(encoder.encode(": connected\n\n"));
      },
    });

    const unsub = subscribe(getClaudeDir(), (evt) => {
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
      } catch {}
    });

    const ping = setInterval(() => {
      try {
        controller.enqueue(encoder.encode(": ping\n\n"));
      } catch {
        clearInterval(ping);
      }
    }, 15000);

    c.req.raw.signal.addEventListener("abort", () => {
      unsub();
      clearInterval(ping);
      try {
        controller.close();
      } catch {}
    });

    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  return app;
}
```

- [ ] **Step 4: Wire route into server**

Modify `src/web/server.ts`. After the line importing `createSystemRouter`, add:

```ts
import { createTasksRouter } from "./routes/tasks";
```

After the line `app.route("/api/system", createSystemRouter());`, add:

```ts
app.route("/api/tasks", createTasksRouter());
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
bun test src/__tests__/web-tasks-route.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Typecheck and run full backend suite**

```bash
bun run typecheck && bun run test
```

Expected: typecheck clean, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/web/routes/tasks.ts src/web/server.ts src/__tests__/web-tasks-route.test.ts
git commit -m "feat(tasks): add /api/tasks route with SSE stream"
```

---

## Task 5: Frontend — API client additions

**Files:**

- Modify: `web/src/api.ts`

- [ ] **Step 1: Add types and client methods**

Open `web/src/api.ts`. After the `SseEvent` interface, add:

```ts
export interface TaskSession {
  id: string;
  name: string;
  projectDir: string;
}

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskPayload {
  sessionId: string;
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  updatedAt: number;
}

export type TaskStreamEvent =
  | { type: "task.upsert"; sessionId: string; task: TaskPayload }
  | { type: "task.delete"; sessionId: string; taskId: string }
  | { type: "session.delete"; sessionId: string };

export interface TasksSnapshot {
  sessions: TaskSession[];
  tasks: TaskPayload[];
}
```

Inside the `api` object (before the closing `};`), add:

```ts
  async getTasks(): Promise<TasksSnapshot> {
    const res = await fetch(`${BASE}/tasks`, { headers: headers() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  streamTasks(
    onEvent: (evt: TaskStreamEvent) => void,
    onError?: () => void,
  ): () => void {
    const initData = encodeURIComponent(getInitData());
    const url = `${BASE}/tasks/stream?initData=${initData}`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      try {
        onEvent(JSON.parse(e.data));
      } catch {}
    };
    if (onError) es.onerror = onError;
    return () => es.close();
  },
```

- [ ] **Step 2: Typecheck the web app**

```bash
cd web && bunx tsc --noEmit && cd ..
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/api.ts
git commit -m "feat(web): add tasks types and api client methods"
```

---

## Task 6: Frontend — `KanbanCard` component

**Files:**

- Create: `web/src/components/KanbanCard.tsx`

- [ ] **Step 1: Implement the card**

Create `web/src/components/KanbanCard.tsx`:

```tsx
import type { TaskPayload, TaskSession } from "../api";

interface KanbanCardProps {
  task: TaskPayload;
  session?: TaskSession;
  showSessionLabel: boolean;
  onTap: (task: TaskPayload) => void;
}

function borderColor(status: TaskPayload["status"]): string {
  if (status === "in_progress") return "border-l-terminal-green";
  if (status === "completed") return "border-l-terminal-muted opacity-70";
  return "border-l-terminal-border";
}

function timeSince(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function KanbanCard({
  task,
  session,
  showSessionLabel,
  onTap,
}: KanbanCardProps) {
  const projectLeaf =
    session?.projectDir?.split("/").filter(Boolean).pop() ?? "";
  const sessionLabel = session
    ? projectLeaf
      ? `${session.name} • ${projectLeaf}`
      : session.name
    : task.sessionId.slice(0, 8);

  return (
    <button
      onClick={() => onTap(task)}
      data-testid="kanban-card"
      className={`w-full text-left bg-terminal-surface border border-terminal-border border-l-4 ${borderColor(
        task.status,
      )} rounded px-2 py-2 mb-2 hover:bg-terminal-bg transition-colors`}
    >
      <div className="text-sm text-terminal-text font-bold line-clamp-2">
        {task.subject}
      </div>
      {showSessionLabel && (
        <div
          data-testid="session-label"
          className="mt-1 inline-block text-[10px] text-terminal-green bg-terminal-bg border border-terminal-border rounded-full px-2 py-0.5"
        >
          {sessionLabel}
        </div>
      )}
      <div className="mt-1 text-[10px] text-terminal-muted">
        {timeSince(task.updatedAt)}
      </div>
    </button>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd web && bunx tsc --noEmit && cd ..
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/KanbanCard.tsx
git commit -m "feat(web): add KanbanCard component"
```

---

## Task 7: Frontend — `KanbanBoard` component

**Files:**

- Create: `web/src/components/KanbanBoard.tsx`

- [ ] **Step 1: Implement the board**

Create `web/src/components/KanbanBoard.tsx`:

```tsx
import type { TaskPayload, TaskSession, TaskStatus } from "../api";
import { KanbanCard } from "./KanbanCard";

interface KanbanBoardProps {
  tasks: TaskPayload[];
  sessionsById: Map<string, TaskSession>;
  showSessionLabel: boolean;
  onCardTap: (task: TaskPayload) => void;
}

const COLUMNS: Array<{ status: TaskStatus; label: string }> = [
  { status: "pending", label: "Pending" },
  { status: "in_progress", label: "In Progress" },
  { status: "completed", label: "Completed" },
];

export function KanbanBoard({
  tasks,
  sessionsById,
  showSessionLabel,
  onCardTap,
}: KanbanBoardProps) {
  const byStatus = new Map<TaskStatus, TaskPayload[]>();
  for (const c of COLUMNS) byStatus.set(c.status, []);
  for (const t of tasks) byStatus.get(t.status)?.push(t);

  for (const list of byStatus.values()) {
    list.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return (
    <div
      data-testid="kanban-board"
      className="flex-1 overflow-x-auto snap-x snap-mandatory flex gap-2 px-2 py-2 md:overflow-x-visible md:snap-none md:grid md:grid-cols-3 md:gap-3"
    >
      {COLUMNS.map((col) => {
        const list = byStatus.get(col.status)!;
        return (
          <section
            key={col.status}
            data-testid={`kanban-col-${col.status}`}
            className="w-[85vw] flex-shrink-0 snap-center md:w-auto flex flex-col"
          >
            <header className="flex items-center justify-between px-1 py-1 mb-2 border-b border-terminal-border">
              <span className="text-xs text-terminal-green font-bold uppercase tracking-widest">
                {col.label}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-terminal-surface border border-terminal-border text-terminal-muted">
                {list.length}
              </span>
            </header>
            <div className="flex-1 overflow-y-auto">
              {list.map((task) => (
                <KanbanCard
                  key={`${task.sessionId}:${task.id}`}
                  task={task}
                  session={sessionsById.get(task.sessionId)}
                  showSessionLabel={showSessionLabel}
                  onTap={onCardTap}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd web && bunx tsc --noEmit && cd ..
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/KanbanBoard.tsx
git commit -m "feat(web): add KanbanBoard with responsive layout"
```

---

## Task 8: Frontend — `TaskDetailSheet` component

**Files:**

- Create: `web/src/components/TaskDetailSheet.tsx`

- [ ] **Step 1: Implement the sheet**

Create `web/src/components/TaskDetailSheet.tsx`:

```tsx
import { useState } from "react";
import type { TaskPayload, TaskSession } from "../api";
import { api } from "../api";

interface TaskDetailSheetProps {
  task: TaskPayload;
  session?: TaskSession;
  onClose: () => void;
  onSwitchToChat: () => void;
}

export function TaskDetailSheet({
  task,
  session,
  onClose,
  onSwitchToChat,
}: TaskDetailSheetProps) {
  const [busy, setBusy] = useState(false);

  const handleOpen = async () => {
    if (!session) return;
    setBusy(true);
    try {
      await api.activateSession(session.name);
      onSwitchToChat();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-20 flex items-end bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full bg-terminal-surface border-t border-terminal-border rounded-t-lg p-4 max-h-[70vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs uppercase tracking-widest text-terminal-muted">
            {task.status.replace("_", " ")}
          </span>
          <button
            onClick={onClose}
            className="text-terminal-muted text-sm"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <h2 className="text-base font-bold text-terminal-text mb-2">
          {task.subject}
        </h2>
        {task.description && (
          <p className="text-sm text-terminal-text whitespace-pre-wrap mb-4">
            {task.description}
          </p>
        )}
        {session && (
          <div className="text-xs text-terminal-muted mb-3">
            {session.name}
            {session.projectDir ? ` • ${session.projectDir}` : ""}
          </div>
        )}
        <button
          onClick={handleOpen}
          disabled={busy || !session}
          className="w-full py-2 rounded border border-terminal-green text-terminal-green text-sm uppercase tracking-widest disabled:opacity-50"
        >
          {busy ? "Opening…" : "Open in chat"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd web && bunx tsc --noEmit && cd ..
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/TaskDetailSheet.tsx
git commit -m "feat(web): add TaskDetailSheet with open-in-chat action"
```

---

## Task 9: Frontend — `TasksPage`

**Files:**

- Create: `web/src/pages/TasksPage.tsx`

- [ ] **Step 1: Implement the page**

Create `web/src/pages/TasksPage.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { TaskPayload, TaskSession, TaskStreamEvent } from "../api";
import { KanbanBoard } from "../components/KanbanBoard";
import { TaskDetailSheet } from "../components/TaskDetailSheet";

interface TasksPageProps {
  onSwitchToChat: () => void;
}

const FILTER_KEY = "tasks.sessionFilter";

function keyOf(sessionId: string, taskId: string): string {
  return `${sessionId}:${taskId}`;
}

export function TasksPage({ onSwitchToChat }: TasksPageProps) {
  const [sessions, setSessions] = useState<TaskSession[]>([]);
  const [tasks, setTasks] = useState<Map<string, TaskPayload>>(new Map());
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>(
    () => localStorage.getItem(FILTER_KEY) ?? "all",
  );
  const [open, setOpen] = useState<TaskPayload | null>(null);
  const streamRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await api.getTasks();
        if (cancelled) return;
        setSessions(snap.sessions);
        setTasks(new Map(snap.tasks.map((t) => [keyOf(t.sessionId, t.id), t])));
      } catch {
        // surface via empty state
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    streamRef.current = api.streamTasks((evt: TaskStreamEvent) => {
      if (evt.type === "task.upsert") {
        setTasks((prev) => {
          const next = new Map(prev);
          next.set(keyOf(evt.sessionId, evt.task.id), evt.task);
          return next;
        });
        setSessions((prev) =>
          prev.find((s) => s.id === evt.sessionId)
            ? prev
            : [
                ...prev,
                { id: evt.sessionId, name: evt.sessionId, projectDir: "" },
              ],
        );
      } else if (evt.type === "task.delete") {
        setTasks((prev) => {
          const next = new Map(prev);
          next.delete(keyOf(evt.sessionId, evt.taskId));
          return next;
        });
      } else if (evt.type === "session.delete") {
        setTasks((prev) => {
          const next = new Map(prev);
          for (const k of [...next.keys()]) {
            if (next.get(k)!.sessionId === evt.sessionId) next.delete(k);
          }
          return next;
        });
        setSessions((prev) => prev.filter((s) => s.id !== evt.sessionId));
      }
    });

    return () => {
      cancelled = true;
      streamRef.current?.();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(FILTER_KEY, filter);
  }, [filter]);

  const sessionsById = useMemo(
    () => new Map(sessions.map((s) => [s.id, s])),
    [sessions],
  );

  const visible = useMemo(() => {
    const all = [...tasks.values()];
    if (filter === "all") return all;
    return all.filter((t) => t.sessionId === filter);
  }, [tasks, filter]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-terminal-border bg-terminal-surface overflow-x-auto">
        <span className="text-terminal-green text-sm font-bold shrink-0">
          tasks
        </span>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="bg-terminal-bg border border-terminal-border text-terminal-text text-xs rounded px-2 py-1"
        >
          <option value="all">All sessions</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <span className="text-[10px] text-terminal-muted ml-auto shrink-0">
          {visible.length} tasks
        </span>
      </div>
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-terminal-muted text-sm">
          loading…
        </div>
      ) : visible.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-terminal-muted text-sm">
          no tasks
        </div>
      ) : (
        <KanbanBoard
          tasks={visible}
          sessionsById={sessionsById}
          showSessionLabel={filter === "all"}
          onCardTap={setOpen}
        />
      )}
      {open && (
        <TaskDetailSheet
          task={open}
          session={sessionsById.get(open.sessionId)}
          onClose={() => setOpen(null)}
          onSwitchToChat={onSwitchToChat}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd web && bunx tsc --noEmit && cd ..
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/TasksPage.tsx
git commit -m "feat(web): add TasksPage with live SSE state and session filter"
```

---

## Task 10: Frontend — wire Tasks into `App` + `BottomNav`

**Files:**

- Modify: `web/src/App.tsx`
- Modify: `web/src/components/BottomNav.tsx`

- [ ] **Step 1: Update `BottomNav`**

Replace the contents of `web/src/components/BottomNav.tsx` with:

```tsx
type Tab = "chat" | "sessions" | "tasks" | "status" | "agents";

interface BottomNavProps {
  active: Tab;
  onChange: (tab: Tab) => void;
}

const TABS: Array<{ id: Tab; icon: string; label: string }> = [
  { id: "chat", icon: "⌨", label: "Chat" },
  { id: "sessions", icon: "▤", label: "Sessions" },
  { id: "tasks", icon: "▦", label: "Tasks" },
  { id: "status", icon: "◉", label: "Status" },
  { id: "agents", icon: "◈", label: "Agents" },
];

export function BottomNav({ active, onChange }: BottomNavProps) {
  return (
    <nav className="flex bg-terminal-surface border-t border-terminal-border">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-xs uppercase tracking-widest transition-colors ${
            active === tab.id ? "text-terminal-green" : "text-terminal-muted"
          }`}
        >
          <span className="text-base">{tab.icon}</span>
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: Update `App.tsx`**

Replace the contents of `web/src/App.tsx` with:

```tsx
import { useState } from "react";
import { BottomNav } from "./components/BottomNav";
import { ChatPage } from "./pages/ChatPage";
import { SessionsPage } from "./pages/SessionsPage";
import { StatusPage } from "./pages/StatusPage";
import { AgentsPage } from "./pages/AgentsPage";
import { TasksPage } from "./pages/TasksPage";

type Tab = "chat" | "sessions" | "tasks" | "status" | "agents";

export default function App() {
  const [tab, setTab] = useState<Tab>("chat");

  return (
    <div className="flex flex-col h-screen bg-terminal-bg text-terminal-text font-mono overflow-hidden">
      <div className="flex-1 overflow-hidden">
        {tab === "chat" && <ChatPage />}
        {tab === "sessions" && (
          <SessionsPage onSwitchToChat={() => setTab("chat")} />
        )}
        {tab === "tasks" && <TasksPage onSwitchToChat={() => setTab("chat")} />}
        {tab === "status" && <StatusPage />}
        {tab === "agents" && <AgentsPage />}
      </div>
      <BottomNav active={tab} onChange={setTab} />
    </div>
  );
}
```

- [ ] **Step 3: Build the frontend**

```bash
cd web && bun run build && cd ..
```

Expected: successful build, `web/dist/` updated.

- [ ] **Step 4: Commit**

```bash
git add web/src/App.tsx web/src/components/BottomNav.tsx
git commit -m "feat(web): add Tasks tab to BottomNav and App router"
```

---

## Task 11: Frontend tests — vitest + jsdom setup

**Files:**

- Modify: `web/package.json`
- Create: `web/vitest.config.ts`
- Create: `web/src/test-setup.ts`

- [ ] **Step 1: Install test dependencies**

```bash
cd web && bun add -d vitest @vitest/ui jsdom @testing-library/react @testing-library/jest-dom @testing-library/dom && cd ..
```

Expected: dependencies added in `web/package.json`.

- [ ] **Step 2: Add test script**

Open `web/package.json`. In the `scripts` section, add:

```json
    "test": "vitest run"
```

So the full scripts block reads:

```json
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
```

- [ ] **Step 3: Create vitest config**

Create `web/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    globals: true,
  },
});
```

- [ ] **Step 4: Create test setup file**

Create `web/src/test-setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 5: Verify setup**

```bash
cd web && bun run test && cd ..
```

Expected: "No test files found" (exit 0 or 1 — acceptable at this stage; config is correct as long as no import errors are shown).

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/bun.lock web/vitest.config.ts web/src/test-setup.ts
git commit -m "test(web): add vitest + jsdom + testing-library setup"
```

---

## Task 12: Frontend — `KanbanBoard` test

**Files:**

- Create: `web/src/__tests__/KanbanBoard.test.tsx`

- [ ] **Step 1: Write the tests**

Create `web/src/__tests__/KanbanBoard.test.tsx`:

```tsx
import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { KanbanBoard } from "../components/KanbanBoard";
import type { TaskPayload, TaskSession } from "../api";

const session: TaskSession = {
  id: "s1",
  name: "my-project",
  projectDir: "/Users/x/my-project",
};

const tasks: TaskPayload[] = [
  {
    sessionId: "s1",
    id: "1",
    subject: "Pending task",
    description: "",
    status: "pending",
    updatedAt: Date.now() - 1000,
  },
  {
    sessionId: "s1",
    id: "2",
    subject: "Working task",
    description: "",
    status: "in_progress",
    updatedAt: Date.now() - 2000,
  },
  {
    sessionId: "s1",
    id: "3",
    subject: "Done task",
    description: "",
    status: "completed",
    updatedAt: Date.now() - 3000,
  },
];

describe("KanbanBoard", () => {
  test("renders three status columns", () => {
    render(
      <KanbanBoard
        tasks={tasks}
        sessionsById={new Map([["s1", session]])}
        showSessionLabel={false}
        onCardTap={() => {}}
      />,
    );
    expect(screen.getByTestId("kanban-col-pending")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-col-in_progress")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-col-completed")).toBeInTheDocument();
  });

  test("groups tasks by status into correct columns", () => {
    render(
      <KanbanBoard
        tasks={tasks}
        sessionsById={new Map([["s1", session]])}
        showSessionLabel={false}
        onCardTap={() => {}}
      />,
    );
    const pending = screen.getByTestId("kanban-col-pending");
    const inProgress = screen.getByTestId("kanban-col-in_progress");
    const completed = screen.getByTestId("kanban-col-completed");
    expect(pending.textContent).toContain("Pending task");
    expect(inProgress.textContent).toContain("Working task");
    expect(completed.textContent).toContain("Done task");
  });

  test("hides session label when showSessionLabel is false", () => {
    render(
      <KanbanBoard
        tasks={tasks}
        sessionsById={new Map([["s1", session]])}
        showSessionLabel={false}
        onCardTap={() => {}}
      />,
    );
    expect(screen.queryAllByTestId("session-label")).toHaveLength(0);
  });

  test("shows session label when showSessionLabel is true", () => {
    render(
      <KanbanBoard
        tasks={tasks}
        sessionsById={new Map([["s1", session]])}
        showSessionLabel={true}
        onCardTap={() => {}}
      />,
    );
    expect(screen.getAllByTestId("session-label").length).toBe(tasks.length);
  });

  test("fires onCardTap with the tapped task", () => {
    const onCardTap = vi.fn();
    render(
      <KanbanBoard
        tasks={tasks}
        sessionsById={new Map([["s1", session]])}
        showSessionLabel={false}
        onCardTap={onCardTap}
      />,
    );
    const cards = screen.getAllByTestId("kanban-card");
    fireEvent.click(cards[0]!);
    expect(onCardTap).toHaveBeenCalledTimes(1);
    expect(onCardTap.mock.calls[0]![0].id).toMatch(/^[123]$/);
  });
});
```

- [ ] **Step 2: Run tests — verify they pass**

```bash
cd web && bun run test && cd ..
```

Expected: 5 passing tests.

- [ ] **Step 3: Commit**

```bash
git add web/src/__tests__/KanbanBoard.test.tsx
git commit -m "test(web): add KanbanBoard rendering + interaction tests"
```

---

## Task 13: Manual verification

**Files:** none (verification only)

- [ ] **Step 1: Build frontend**

```bash
cd web && bun run build && cd ..
```

Expected: build succeeds.

- [ ] **Step 2: Start the dev server**

```bash
bun run dev
```

Leave it running; the bot should come up and log `web: server listening on port <N>`.

- [ ] **Step 3: Open the Mini App**

Send `/app` to the Telegram bot, open the Mini App, tap the **Tasks** tab in the bottom nav.

Expected:

- Tasks tab loads without errors.
- "All sessions" selected by default; other sessions listed in the dropdown.
- Three columns (Pending / In Progress / Completed) render with task cards.
- On a phone: swiping horizontally snaps between columns.
- On desktop (if you open the same URL outside Telegram): the three columns appear side-by-side.
- Cards in "All" view show a session label chip; switching the dropdown to a specific session hides the chips.

- [ ] **Step 4: Live update smoke test**

In a separate terminal, pick a session with tasks:

```bash
ls ~/.claude/tasks/ | head -1
```

Touch a task file to change its mtime:

```bash
touch ~/.claude/tasks/<uuid>/1.json
```

Expected: The corresponding card in the Mini App's Tasks tab moves to the top of its column within ~1 second (mtime updates bump it up the sort order).

Add a new task file:

```bash
echo '{"id":"99","subject":"Manual verify","description":"","activeForm":"","status":"pending","blocks":[],"blockedBy":[]}' > ~/.claude/tasks/<uuid>/99.json
```

Expected: A new "Manual verify" card appears in the Pending column within ~1 second. Clean up when done:

```bash
rm ~/.claude/tasks/<uuid>/99.json
```

Expected: card disappears within ~1 second.

- [ ] **Step 5: Tap-to-open-chat smoke test**

Tap a task card. The detail sheet slides up with the subject, description, and status. Tap "Open in chat". Expected: the Mini App switches to the Chat tab and the chosen session becomes active.

- [ ] **Step 6: Commit — nothing to commit unless you tweaked CSS during verification**

If you made no changes: skip. If you fixed anything, commit it with an appropriate message before reporting completion.

---

## Acceptance criteria

- `bun run typecheck` clean
- `bun run test` clean (backend)
- `cd web && bun run test` clean (frontend)
- Tasks tab renders, filters by session, updates live on file changes
- Tap → detail sheet → "Open in chat" switches to Chat tab with the session active
