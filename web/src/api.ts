const BASE = "/api";

function getInitData(): string {
  return (window as any).Telegram?.WebApp?.initData ?? "";
}

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Telegram-Init-Data": getInitData(),
  };
}

export interface ApiSession {
  id: string;
  name: string;
  dir: string;
  lastActivity: number;
  source: "telegram" | "desktop";
  live: boolean;
  active: boolean;
}

export interface SystemStats {
  cpu: number;
  memory: { used: number; total: number; usedPercent: number };
  disk: { used: number; total: number; usedPercent: number };
  processes: Array<{ name: string; pid: number; cpu: number }>;
}

export interface SseEvent {
  type:
    | "text"
    | "tool"
    | "thinking"
    | "segment_end"
    | "done"
    | "send_file"
    | "tool_result"
    | "permission_mode"
    | "hook_summary";
  content: string;
  segmentId?: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  isError?: boolean;
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  hook?: {
    hookCount: number;
    errorCount: number;
    preventedContinuation: boolean;
    firstError?: string;
    failingHookName?: string;
  };
}

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

export const api = {
  async getSessions(): Promise<ApiSession[]> {
    const res = await fetch(`${BASE}/sessions`, { headers: headers() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async sendMessage(sessionId: string, text: string): Promise<void> {
    await fetch(`${BASE}/sessions/${sessionId}/message`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ text }),
    });
  },

  streamSession(
    sessionId: string,
    onEvent: (evt: SseEvent) => void,
    onError?: () => void,
  ): () => void {
    const initData = encodeURIComponent(getInitData());
    const url = `${BASE}/sessions/${sessionId}/stream?initData=${initData}`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      try {
        onEvent(JSON.parse(e.data));
      } catch {}
    };
    if (onError) es.onerror = onError;
    return () => es.close();
  },

  async getSystem(): Promise<SystemStats> {
    const res = await fetch(`${BASE}/system`, { headers: headers() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async spawnAgent(dir: string): Promise<{ sessionId: string; name: string }> {
    const res = await fetch(`${BASE}/agents/spawn`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ dir }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async activateSession(name: string): Promise<void> {
    const res = await fetch(
      `${BASE}/sessions/${encodeURIComponent(name)}/activate`,
      {
        method: "POST",
        headers: headers(),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },

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

  async getSessionHistory(sessionId: string, limit = 200): Promise<SseEvent[]> {
    const res = await fetch(
      `${BASE}/sessions/${sessionId}/history?limit=${limit}`,
      { headers: headers() },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { events: SseEvent[] };
    return body.events;
  },

  async getToolMetrics(
    sessionId: string,
    windowMs = 60 * 60 * 1000,
  ): Promise<ToolMetricsResponse> {
    const res = await fetch(
      `${BASE}/sessions/${sessionId}/tool-metrics?window=${windowMs}`,
      { headers: headers() },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
};

export interface ToolMetricsAggregate {
  toolName: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  errorPct: number;
  lastSeenMs: number;
}

export interface ToolMetricsResponse {
  sessionId: string;
  windowMs: number;
  tools: ToolMetricsAggregate[];
}
