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
