import { useEffect, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { SseEvent } from "../api";

interface TerminalProps {
  events: SseEvent[];
  streaming: boolean;
}

function eventClass(type: SseEvent["type"]): string {
  switch (type) {
    case "text":
      return "text-terminal-text";
    case "tool":
      return "text-terminal-muted text-xs";
    case "thinking":
      return "text-terminal-muted italic text-xs";
    default:
      return "text-terminal-muted";
  }
}

function eventPrefix(type: SseEvent["type"]): string {
  switch (type) {
    case "tool":
      return "⚙ ";
    case "thinking":
      return "… ";
    default:
      return "";
  }
}

function renderHtml(evt: SseEvent): { __html: string } {
  try {
    if (evt.type === "text") {
      const html = marked.parse(evt.content, {
        async: false,
        breaks: true,
      }) as string;
      return { __html: DOMPurify.sanitize(html) };
    }
    return { __html: DOMPurify.sanitize(evt.content) };
  } catch {
    const escaped = evt.content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return { __html: escaped };
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
            <span dangerouslySetInnerHTML={renderHtml(evt)} />
          </div>
        ) : null,
      )}
      {streaming && (
        <span className="inline-block w-2 h-4 bg-terminal-green animate-pulse" />
      )}
      <div ref={bottomRef} />
    </div>
  );
}
