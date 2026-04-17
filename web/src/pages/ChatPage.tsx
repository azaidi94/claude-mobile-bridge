import { useState, useEffect, useRef, useCallback } from "react";
import { api, type ApiSession, type SseEvent } from "../api";
import { Terminal } from "../components/Terminal";

export function ChatPage() {
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [events, setEvents] = useState<SseEvent[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    api.getSessions().then((s) => {
      setSessions(s);
      const active = s.find((x) => x.active) ?? s[0];
      if (active) setActiveId(active.id);
    });
  }, []);

  useEffect(() => {
    if (!activeId) return;
    unsubRef.current?.();
    setEvents([]);
    setStreaming(false);
    const unsub = api.streamSession(activeId, (evt) => {
      if (evt.type === "done") {
        setStreaming(false);
      } else {
        setStreaming(true);
        setEvents((prev) => [...prev, evt]);
      }
    });
    unsubRef.current = unsub;
    return unsub;
  }, [activeId]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !activeId) return;
    setInput("");
    setEvents((prev) => [...prev, { type: "text", content: `› ${text}` } as SseEvent]);
    setStreaming(true);
    await api.sendMessage(activeId, text);
  }, [input, activeId]);

  const activeSession = sessions.find((s) => s.id === activeId);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-terminal-border bg-terminal-surface">
        <span className="text-terminal-green text-sm font-bold">
          {activeSession?.name ?? "claude-bridge"}
        </span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-terminal-bg border border-terminal-border text-terminal-green">
          {streaming ? "● live" : "○ idle"}
        </span>
      </div>
      <Terminal events={events} streaming={streaming} />
      <div className="flex gap-2 p-2 border-t border-terminal-border bg-terminal-surface">
        <input
          className="flex-1 bg-terminal-bg border border-terminal-border rounded-lg px-3 py-2 text-sm text-terminal-text placeholder-terminal-muted focus:outline-none focus:border-terminal-green"
          placeholder="Message..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button
          onClick={send}
          className="bg-terminal-green text-black font-bold rounded-lg px-4 py-2 text-sm"
        >
          ↑
        </button>
      </div>
    </div>
  );
}
