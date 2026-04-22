# Kanban Tasks View Design

**Date:** 2026-04-19
**Status:** Approved

## Overview

Add a Kanban view to the bridge Mini App that surfaces Claude Code's task state across all sessions. Inspired by [L1AD/claude-task-viewer](https://github.com/L1AD/claude-task-viewer) but ported natively into the existing React + Hono bridge rather than embedded as a subprocess.

Scope is intentionally narrow for v1: kanban board + live updates. No Gantt timeline, dependency graph, notifications, search, delete, auto-archive, or keyboard shortcuts.

## Data Source

Claude Code writes tasks to disk at:

```
~/.claude/tasks/{session-uuid}/{N}.json
```

Task shape (already on disk, no migration needed):

```json
{
  "id": "1",
  "subject": "Explore project context",
  "description": "...",
  "activeForm": "Exploring project context",
  "status": "pending" | "in_progress" | "completed",
  "blocks": [],
  "blockedBy": []
}
```

Session metadata (display name, project directory) is read from the first 64 KB of the corresponding JSONL at `~/.claude/projects/{encodedDir}/{session-uuid}.jsonl` — same approach as `claude-task-viewer/server.js` and consistent with the bridge's existing offline-session discovery in `src/sessions/offline.ts`.

A task's `updatedAt` is derived from the JSON file's mtime.

## Backend

### New route: `src/web/routes/tasks.ts`

Hono router mounted under `/api/tasks`, protected by the existing `authMiddleware`.

| Route                   | Method    | Purpose                                        |
| ----------------------- | --------- | ---------------------------------------------- |
| `GET /api/tasks`        | GET       | Snapshot of all sessions + tasks               |
| `GET /api/tasks/stream` | GET (SSE) | Stream of `task.upsert` / `task.delete` events |

`GET /api/tasks` response:

```ts
{
  sessions: Array<{ id: string; name: string; projectDir: string }>;
  tasks: Array<{
    sessionId: string;
    id: string;
    subject: string;
    description: string;
    status: "pending" | "in_progress" | "completed";
    updatedAt: number; // ms epoch
  }>;
}
```

SSE event shape:

```ts
{ type: "task.upsert", sessionId: string, task: TaskPayload }
{ type: "task.delete", sessionId: string, taskId: string }
{ type: "session.delete", sessionId: string }
```

### File watcher

A single `chokidar` watcher at module scope in `tasks.ts` watches `{CLAUDE_DIR}/tasks/` recursively (where `CLAUDE_DIR` is a new config value in `src/config.ts`, defaulting to `~/.claude`, overridable by env for tests). It fans out events to all SSE subscribers via an internal `EventEmitter` (not `globalEventBus`, which is keyed by session id for chat streams — task events are broadcast).

Watcher → SSE event mapping:

- `add` or `change` on a task JSON → `task.upsert`
- `unlink` on a task JSON → `task.delete`
- `unlinkDir` on a session directory → `session.delete`

Watcher lifecycle:

- Started lazily on first subscriber; never stopped (cost is low — a single recursive fs watch).
- Subscribers unsubscribe on request abort.
- Initial snapshot is served by the `GET /` handler, not replayed through the watcher. Clients call `GET /api/tasks` once on mount, then subscribe to the stream for deltas.

### Server wiring

In `src/web/server.ts`:

```ts
import { createTasksRouter } from "./routes/tasks";
// ...
app.route("/api/tasks", createTasksRouter());
```

## Frontend

### New page: `web/src/pages/TasksPage.tsx`

Owns the session selector and the live task state. On mount:

1. `api.getTasks()` to populate initial `sessions` and `tasks` state.
2. `api.streamTasks(onEvent)` to subscribe to deltas, mutate state on upsert/delete.

State shape:

```ts
const [sessions, setSessions] = useState<TaskSession[]>([]);
const [tasks, setTasks] = useState<
  Map<string /* sessionId:taskId */, TaskPayload>
>(new Map());
const [sessionFilter, setSessionFilter] = useState<string | "all">("all");
```

### New components

- `web/src/components/KanbanBoard.tsx` — takes a filtered task list, renders 3 columns.
- `web/src/components/KanbanCard.tsx` — single task card.
- `web/src/components/TaskDetailSheet.tsx` — bottom-sheet modal for tap-to-open-detail with "Open in chat" action.

### Layout

Three columns: **Pending** / **In Progress** / **Completed**.

Mobile (default):

- Container: `overflow-x-auto snap-x snap-mandatory`
- Each column: `w-[85vw] flex-shrink-0 snap-center`
- Vertical scroll inside each column

Desktop (`md:` breakpoint, ≥ 768 px):

- Container: `md:overflow-visible md:snap-none md:grid md:grid-cols-3 md:gap-3`
- Each column: `md:w-auto`

Column headers show status name + count pill.

### Card content

- Subject (bold, truncate at 2 lines)
- Status-colored left border (4 px): pending = gray, in_progress = terminal-green, completed = dimmed
- Session label chip (name + last path segment of projectDir) — **only rendered when `sessionFilter === "all"`**
- Relative time (`updatedAt`) in small muted text

### Session selector

Top bar of `TasksPage`: a pill selector styled consistently with the existing `SessionsPage` header. Default option "All sessions", followed by each session by name. Persist selection in `localStorage` under `tasks.sessionFilter`.

### BottomNav update

`web/src/components/BottomNav.tsx` — add a fifth entry "tasks" between "sessions" and "status". `web/src/App.tsx` `Tab` type gains `"tasks"` and renders `<TasksPage onSwitchToChat={() => setTab("chat")} />`. The `onSwitchToChat` prop is plumbed into `TaskDetailSheet` so the "Open in chat" button can switch tabs (same pattern `SessionsPage` already uses).

### API client additions

`web/src/api.ts`:

```ts
export interface TaskSession { id: string; name: string; projectDir: string }
export interface TaskPayload {
  sessionId: string; id: string; subject: string; description: string;
  status: "pending" | "in_progress" | "completed"; updatedAt: number;
}
export type TaskStreamEvent =
  | { type: "task.upsert"; sessionId: string; task: TaskPayload }
  | { type: "task.delete"; sessionId: string; taskId: string }
  | { type: "session.delete"; sessionId: string };

api.getTasks(): Promise<{ sessions: TaskSession[]; tasks: TaskPayload[] }>
api.streamTasks(onEvent: (e: TaskStreamEvent) => void, onError?: () => void): () => void
```

## Interaction Model

Tap a card → `TaskDetailSheet` slides up with full description + "Open in chat" button. The button:

1. Calls `api.activateSession(sessionName)` to set the active bridge session.
2. Switches the current tab to `"chat"` via the `setTab` prop plumbed from `App.tsx`.

This makes the Kanban a navigation surface into the existing session-control flow — consistent with how `SessionsPage` hands off to chat today.

Cards are otherwise read-only. The kanban observes; Claude owns task state.

## Error Handling

- `GET /api/tasks`: if `~/.claude/tasks/` doesn't exist, return `{ sessions: [], tasks: [] }` (don't error).
- Malformed task JSON: skip the file, log a warning; don't crash the watcher.
- Watcher errors: log and let chokidar's internal retry handle it.
- SSE client disconnect: the existing abort-signal pattern in `routes/sessions.ts` is copied verbatim.
- Frontend: if the stream errors, show a subtle reconnect indicator; retry with exponential backoff via a small wrapper around `EventSource`.

## Testing

### Backend: `src/web/routes/__tests__/tasks.test.ts`

- Creates a temporary `~/.claude/tasks/` in a tmpdir, sets a `CLAUDE_DIR` env override (new — add to `src/config.ts`, defaults to `~/.claude`).
- `GET /api/tasks` returns expected sessions + tasks from fixture files.
- Writing a new JSON file emits `task.upsert` on the SSE stream.
- Deleting a file emits `task.delete`.
- Deleting a session directory emits `session.delete`.
- Malformed JSON is skipped without killing the stream.

### Frontend: `web/src/__tests__/KanbanBoard.test.tsx`

- Renders exactly 3 columns with correct counts.
- Tasks group by status correctly.
- Session label chip renders in "All" view, hidden in per-session view.
- Tap on card fires the detail-sheet callback.

## Out of Scope (v1)

- Gantt/timeline view
- Task dependency visualization (blockedBy/blocks)
- Desktop / sound notifications
- Fuzzy search
- Auto-archive of stale sessions
- Delete tasks / bulk delete
- Keyboard shortcuts
- Drag-to-reorder (irrelevant — Claude owns state)

## Future Work

- Timeline view as a second mode toggle on `TasksPage`
- Task dependency overlay (arrows between cards or a small badge)
- Notification hook into the existing Telegram relay — notify a topic when a task completes
