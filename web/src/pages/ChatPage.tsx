import { useState, useEffect, useRef, useCallback } from "react";
import { api, type ApiSession, type SseEvent } from "../api";
import { Terminal } from "../components/Terminal";

export function ChatPage() {
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [events, setEvents] = useState<SseEvent[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const clientIdRef = useRef<string>(crypto.randomUUID());
  // Tracks text we just sent — Cursor's DOM observer echoes the same
  // text back via user_message+cursor after injection, which would
  // render as "🖱 CURSOR" duplicating our optimistic "YOU" insert.
  const recentSentRef = useRef<Map<string, number>>(new Map());
  const SENT_TTL_MS = 30_000;
  // Belt-and-suspenders: if streaming stays true for too long (e.g.
  // a session never emits a 'done' event) the input stays disabled
  // and the user can't type. Auto-clear after this long.
  const STREAMING_TIMEOUT_MS = 60_000;
  const streamingTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!streaming) {
      inputRef.current?.focus();
      if (streamingTimerRef.current !== null) {
        window.clearTimeout(streamingTimerRef.current);
        streamingTimerRef.current = null;
      }
      return;
    }
    // Streaming just started — set a safety timer to auto-clear in case
    // the session never sends a 'done'.
    if (streamingTimerRef.current !== null) {
      window.clearTimeout(streamingTimerRef.current);
    }
    streamingTimerRef.current = window.setTimeout(() => {
      setStreaming(false);
      streamingTimerRef.current = null;
    }, STREAMING_TIMEOUT_MS);
    return () => {
      if (streamingTimerRef.current !== null) {
        window.clearTimeout(streamingTimerRef.current);
        streamingTimerRef.current = null;
      }
    };
  }, [streaming]);

  useEffect(() => {
    api.getSessions().then((s) => {
      setSessions(s);
      const active = s.find((x) => x.active) ?? s[0];
      if (active) setActiveId(active.id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!activeId) return;
    unsubRef.current?.();

    let cancelled = false;
    (async () => {
      try {
        const hist = await api.getSessionHistory(activeId);
        if (!cancelled) setEvents(hist);
      } catch {
        if (!cancelled) setEvents([]);
      }
    })();

    setStreaming(false);
    const unsub = api.streamSession(
      activeId,
      (evt) => {
        if (evt.type === "done") {
          setStreaming(false);
          return;
        }
        if (
          evt.type === "user_message" &&
          evt.source === "web" &&
          evt.clientId === clientIdRef.current
        ) {
          // Suppress own echo — already shown optimistically in send()
          return;
        }
        if (evt.type === "user_message" && evt.source === "cursor") {
          const sentAt = recentSentRef.current.get(evt.content);
          if (sentAt && Date.now() - sentAt < SENT_TTL_MS) {
            // Cursor echoed our own injection — already shown as "YOU"
            recentSentRef.current.delete(evt.content);
            return;
          }
        }
        // Cursor sessions don't emit a 'done' event — when the AI
        // bridge flushes a text+cursor reply, that IS the response,
        // so flip back to idle so the input can be re-used.
        if (evt.type === "text" && evt.source === "cursor") {
          setStreaming(false);
        } else {
          setStreaming(true);
        }
        setEvents((prev) => [...prev, evt]);
      },
      undefined,
      clientIdRef.current,
    );
    unsubRef.current = unsub;

    return () => {
      cancelled = true;
      unsub();
    };
  }, [activeId]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !activeId || streaming) return;
    setInput("");
    setSendError(null);
    setEvents((prev) => [
      ...prev,
      {
        type: "user_message",
        source: "web",
        content: text,
        clientId: clientIdRef.current,
      } as SseEvent,
    ]);
    setStreaming(true);
    // Mark this content so we can suppress the cursor-side echo.
    // Pruning happens lazily on each match; entries that never match
    // (e.g. session is desktop, no cursor echo) age out via the TTL.
    recentSentRef.current.set(text, Date.now());
    for (const [k, t] of recentSentRef.current) {
      if (Date.now() - t > SENT_TTL_MS) recentSentRef.current.delete(k);
    }
    try {
      await api.sendMessage(activeId, text, clientIdRef.current);
    } catch {
      setSendError("Send failed");
      setInput(text);
    }
  }, [input, activeId, streaming]);

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
          ref={inputRef}
          className="flex-1 bg-terminal-bg border border-terminal-border rounded-lg px-3 py-2 text-sm text-terminal-text placeholder-terminal-muted focus:outline-none focus:border-terminal-green"
          placeholder="Message..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          disabled={streaming}
        />
        <button
          onClick={send}
          disabled={streaming}
          className="bg-terminal-green text-black font-bold rounded-lg px-4 py-2 text-sm disabled:opacity-50"
        >
          ↑
        </button>
      </div>
      {sendError && <p className="text-red-400 text-xs px-2 pb-1">{sendError}</p>}
    </div>
  );
}
