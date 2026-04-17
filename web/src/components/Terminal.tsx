import { useEffect, useRef } from "react";
import type { SseEvent } from "../api";

interface TerminalProps {
  events: SseEvent[];
  streaming: boolean;
}

function eventClass(type: SseEvent["type"]): string {
  switch (type) {
    case "text": return "text-terminal-text";
    case "tool": return "text-terminal-muted text-xs";
    case "thinking": return "text-terminal-muted italic text-xs";
    default: return "text-terminal-muted";
  }
}

function eventPrefix(type: SseEvent["type"]): string {
  switch (type) {
    case "tool": return "⚙ ";
    case "thinking": return "… ";
    default: return "";
  }
}

export function Terminal({ events, streaming }: TerminalProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-1 text-sm leading-relaxed">
      {events.map((evt, i) =>
        evt.type !== "segment_end" && evt.type !== "done" ? (
          <div key={i} className={eventClass(evt.type)}>
            <span className="text-terminal-muted">{eventPrefix(evt.type)}</span>
            {evt.content}
          </div>
        ) : null
      )}
      {streaming && (
        <span className="inline-block w-2 h-4 bg-terminal-green animate-pulse" />
      )}
      <div ref={bottomRef} />
    </div>
  );
}
