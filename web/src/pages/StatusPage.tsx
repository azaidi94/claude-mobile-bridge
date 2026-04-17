import { useEffect, useState } from "react";
import { api, type SystemStats } from "../api";

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 ** 3);
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${(bytes / (1024 ** 2)).toFixed(0)}MB`;
}

interface GaugeProps {
  label: string;
  value: number;
  display: string;
  warn?: boolean;
}

function Gauge({ label, value, display, warn }: GaugeProps) {
  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg p-3 text-center">
      <div className="text-terminal-muted text-xs uppercase tracking-widest mb-1">{label}</div>
      <div className={`font-mono text-xl font-bold ${warn ? "text-yellow-400" : "text-terminal-green"}`}>
        {display}
      </div>
      <div className="mt-2 h-1 rounded bg-terminal-bg overflow-hidden">
        <div
          className={`h-1 rounded transition-all ${warn ? "bg-yellow-400" : "bg-terminal-green"}`}
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </div>
    </div>
  );
}

export function StatusPage() {
  const [stats, setStats] = useState<SystemStats | null>(null);

  useEffect(() => {
    const fetchStats = () => api.getSystem().then(setStats).catch(() => {});
    fetchStats();
    const id = setInterval(fetchStats, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-terminal-border bg-terminal-surface">
        <span className="text-terminal-green text-sm font-bold">system</span>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {!stats && <p className="text-terminal-muted text-xs">Loading...</p>}
        {stats && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Gauge label="CPU" value={stats.cpu} display={`${stats.cpu}%`} warn={stats.cpu > 80} />
              <Gauge label="Memory" value={stats.memory.usedPercent} display={`${stats.memory.usedPercent}%`} warn={stats.memory.usedPercent > 80} />
              <Gauge label="Disk" value={stats.disk.usedPercent} display={`${stats.disk.usedPercent}%`} warn={stats.disk.usedPercent > 85} />
              <Gauge label="Memory Used" value={stats.memory.usedPercent} display={formatBytes(stats.memory.used)} />
            </div>
            <div>
              <div className="text-xs text-terminal-muted uppercase tracking-widest mb-2">Processes</div>
              <div className="space-y-1">
                {stats.processes.map((p, i) => (
                  <div key={i} className="flex justify-between text-xs font-mono py-1 border-b border-terminal-border last:border-0">
                    <span className="text-terminal-text">{p.name}</span>
                    <span className="text-terminal-muted">PID {p.pid}</span>
                    <span className="text-terminal-green">{p.cpu.toFixed(1)}%</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
