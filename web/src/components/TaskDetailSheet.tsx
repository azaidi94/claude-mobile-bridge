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
