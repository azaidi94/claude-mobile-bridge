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
        setTasks(
          new Map(snap.tasks.map((t) => [keyOf(t.sessionId, t.id), t])),
        );
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
