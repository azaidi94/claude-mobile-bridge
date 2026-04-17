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
  type: "text" | "tool" | "thinking" | "segment_end" | "done" | "send_file";
  content: string;
  segmentId?: number;
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
    const url = `${BASE}/sessions/${sessionId}/stream`;
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
};
