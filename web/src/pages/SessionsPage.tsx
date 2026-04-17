import { useEffect, useState, useCallback } from "react";
import { api, type ApiSession } from "../api";

interface SessionsPageProps {
  onSwitchToChat: () => void;
}

function timeSince(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function SessionsPage({ onSwitchToChat }: SessionsPageProps) {
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    api.getSessions().then((s) => {
      setSessions(s);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleActivate = async (session: ApiSession) => {
    try {
      if (session.live) {
        await api.activateSession(session.name);
      } else {
        await api.spawnAgent(session.dir);
      }
      onSwitchToChat();
    } catch {
      // silently stay on sessions page if activation fails
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-terminal-border bg-terminal-surface">
        <span className="text-terminal-green text-sm font-bold">sessions</span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-terminal-bg border border-terminal-border text-terminal-green">
          {sessions.filter((s) => s.live).length} live
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {loading && <p className="text-terminal-muted text-xs p-2">Loading...</p>}
        {sessions.map((session) => (
          <div
            key={session.id || session.name}
            className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
              session.active ? "border-terminal-green bg-terminal-surface" : "border-terminal-border bg-terminal-surface"
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 ${
                session.live ? "bg-terminal-green" : "bg-terminal-muted"
              }`}
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-terminal-text truncate">{session.name}</div>
              <div className="text-xs text-terminal-muted truncate">
                {session.dir} · {timeSince(session.lastActivity)}
              </div>
            </div>
            <button
              onClick={() => handleActivate(session)}
              className={`text-xs px-2 py-1 rounded border flex-shrink-0 ${
                session.active ? "border-terminal-green text-terminal-green" : "border-terminal-border text-terminal-muted"
              }`}
            >
              {session.active ? "active" : session.live ? "switch" : "resume"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
