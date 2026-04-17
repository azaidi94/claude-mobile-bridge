import { useEffect, useState, useCallback } from "react";
import { api, type ApiSession } from "../api";

export function AgentsPage() {
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [spawnDir, setSpawnDir] = useState("");
  const [spawning, setSpawning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.getSessions().then((s) => setSessions(s.filter((x) => x.live))).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const spawn = async () => {
    if (!spawnDir.trim()) return;
    setSpawning(true);
    setError(null);
    try {
      await api.spawnAgent(spawnDir.trim());
      setSpawnDir("");
      await refresh();
    } catch {
      setError("Failed to spawn agent");
    } finally {
      setSpawning(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-terminal-border bg-terminal-surface">
        <span className="text-terminal-green text-sm font-bold">agents</span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-terminal-bg border border-terminal-border text-terminal-green">
          {sessions.length} running
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        <div className="flex gap-2 mb-3">
          <input
            className="flex-1 bg-terminal-bg border border-terminal-border rounded-lg px-3 py-2 text-xs text-terminal-text placeholder-terminal-muted focus:outline-none focus:border-terminal-green"
            placeholder="/path/to/project"
            value={spawnDir}
            onChange={(e) => setSpawnDir(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && spawn()}
          />
          <button
            onClick={spawn}
            disabled={spawning}
            className="text-xs px-3 py-2 rounded-lg border border-terminal-green text-terminal-green bg-terminal-bg disabled:opacity-50"
          >
            {spawning ? "…" : "+ Spawn"}
          </button>
        </div>
        {error && <p className="text-red-400 text-xs">{error}</p>}
        {sessions.map((session) => (
          <div key={session.id || session.name} className="border border-terminal-green/30 bg-terminal-surface rounded-lg p-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-terminal-text font-mono">{session.name}</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-terminal-bg/50 text-terminal-green border border-terminal-green/40">
                running
              </span>
            </div>
            <div className="text-xs text-terminal-muted truncate">{session.dir}</div>
          </div>
        ))}
        {sessions.length === 0 && (
          <p className="text-terminal-muted text-xs text-center py-8">No agents running</p>
        )}
      </div>
    </div>
  );
}
