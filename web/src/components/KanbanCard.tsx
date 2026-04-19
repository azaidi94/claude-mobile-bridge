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
