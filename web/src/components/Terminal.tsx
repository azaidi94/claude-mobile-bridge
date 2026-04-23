import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { diffLines } from "diff";
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
      return "∴ ";
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

function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : p;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

interface DiffRow {
  marker: " " | "-" | "+";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

function buildDiffRows(oldStr: string, newStr: string): DiffRow[] {
  const parts = diffLines(oldStr, newStr);
  const rows: DiffRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const part of parts) {
    const lines = part.value.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      if (part.added) {
        rows.push({ marker: "+", oldNo: null, newNo: newNo++, text: line });
      } else if (part.removed) {
        rows.push({ marker: "-", oldNo: oldNo++, newNo: null, text: line });
      } else {
        rows.push({ marker: " ", oldNo: oldNo++, newNo: newNo++, text: line });
      }
    }
  }
  return rows;
}

function gutter(n: number | null): string {
  if (n === null) return "   ";
  const s = String(n);
  return s.length >= 3 ? s : s.padStart(3, " ");
}

function DiffLines({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const rows = buildDiffRows(oldStr, newStr);
  return (
    <pre className="font-mono text-[11px] leading-snug whitespace-pre-wrap break-all m-0 rounded overflow-hidden">
      {rows.map((row, i) => {
        const isAdd = row.marker === "+";
        const isDel = row.marker === "-";
        const rowClass = isAdd
          ? "bg-green-950/40 text-green-300"
          : isDel
            ? "bg-red-950/40 text-red-300"
            : "text-neutral-300";
        const oldGutterClass = isDel
          ? "text-red-400/80"
          : isAdd
            ? "text-neutral-600"
            : "text-neutral-500";
        const newGutterClass = isAdd
          ? "text-green-400/80"
          : isDel
            ? "text-neutral-600"
            : "text-neutral-500";
        const markerClass = isAdd
          ? "text-green-400"
          : isDel
            ? "text-red-400"
            : "text-neutral-500";
        return (
          <div key={i} className={`flex ${rowClass}`}>
            <span className={`select-none pr-1 tabular-nums ${oldGutterClass}`}>
              {gutter(row.oldNo)}
            </span>
            <span className={`select-none pr-2 tabular-nums ${newGutterClass}`}>
              {gutter(row.newNo)}
            </span>
            <span className={`select-none pr-1 ${markerClass}`}>{row.marker}</span>
            <span className="flex-1">{row.text || " "}</span>
          </div>
        );
      })}
    </pre>
  );
}

const HEADER_MAX = 40;

function clampHeader(s: string): string {
  return s.length > HEADER_MAX ? `${s.slice(0, HEADER_MAX - 1)}…` : s;
}

/** First non-comment, non-blank line of a multi-line bash command. */
function firstExecutableBashLine(cmd: string): string {
  for (const line of cmd.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#")) return line;
  }
  // All comments / blank: fall back to first non-empty line so the user sees
  // SOMETHING rather than "Bash()".
  return cmd.split("\n").find((l) => l.trim()) ?? "";
}

/**
 * Strip "mcp__" prefix and turn "__" into "." so tool names read as
 * "<server>.<tool>" (e.g. "channel-relay.reply"). Falls through unchanged
 * for non-mcp names.
 */
function prettifyMcpName(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  return name.slice(5).replace(/__/g, ".");
}

/** Compact key:value list of input fields, each value clipped. */
function summariseInput(
  input: Record<string, unknown>,
  perValueMax = 20,
): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    let val = typeof v === "string" ? v : JSON.stringify(v);
    val = val.replace(/\s+/g, " ").trim();
    if (val.length > perValueMax) val = val.slice(0, perValueMax - 1) + "…";
    parts.push(`${k}: ${val}`);
  }
  return parts.join(", ");
}

function ToolBlock({
  name,
  input,
}: {
  name: string;
  input: Record<string, unknown>;
}) {
  const header = clampHeader(
    (() => {
      if (["Read", "Write", "Edit"].includes(name)) {
        const path = shortPath(str(input.file_path, "file"));
        // Read with offset/limit shows line range so the reader knows the
        // model isn't reading the whole file (Claude Code TUI does the same).
        if (
          name === "Read" &&
          typeof input.offset === "number" &&
          typeof input.limit === "number"
        ) {
          const start = input.offset;
          const end = start + input.limit - 1;
          return `Read(${path}:${start}-${end})`;
        }
        return `${name}(${path})`;
      }
      if (name === "MultiEdit") {
        const path = shortPath(str(input.file_path, "file"));
        const n = Array.isArray(input.edits) ? input.edits.length : 0;
        return n > 1
          ? `MultiEdit(${path} ×${n})`
          : `MultiEdit(${path})`;
      }
      if (name === "Bash") {
        // Lines-then-chars: the executable line wins; the global clamp does
        // the chars cut. Multi-line scripts still show their command in body.
        return `Bash(${firstExecutableBashLine(str(input.command))})`;
      }
      if (name === "Glob" || name === "Grep") {
        const path = typeof input.path === "string" ? input.path : "";
        const pat = str(input.pattern, "…");
        return path
          ? `${name}("${pat}" in ${shortPath(path)})`
          : `${name}("${pat}")`;
      }
      if (name === "WebFetch") return `WebFetch(${str(input.url, "…")})`;
      if (name === "WebSearch") return `WebSearch(${str(input.query, "…")})`;
      if (name === "Task" || name === "Agent") {
        return `${name}(${str(input.description, str(input.subagent_type, "…"))})`;
      }
      // MCP tools: render as `server.tool(key: value, …)` so the user sees
      // what the model is actually calling. Generic for any mcp__ tool.
      if (name.startsWith("mcp__")) {
        const pretty = prettifyMcpName(name);
        const summary = summariseInput(input);
        return summary ? `${pretty}(${summary})` : pretty;
      }
      return name;
    })(),
  );

  const body = (() => {
    if (name === "Edit") {
      return (
        <DiffLines
          oldStr={str(input.old_string)}
          newStr={str(input.new_string)}
        />
      );
    }
    if (name === "MultiEdit" && Array.isArray(input.edits)) {
      const edits = input.edits as Array<{
        old_string?: string;
        new_string?: string;
      }>;
      return (
        <div className="space-y-1">
          {edits.map((e, i) => (
            <DiffLines
              key={i}
              oldStr={str(e.old_string)}
              newStr={str(e.new_string)}
            />
          ))}
        </div>
      );
    }
    if (name === "Write") {
      const content = str(input.content);
      const lines = content.split("\n");
      const preview = lines.slice(0, 20).join("\n");
      const more = lines.length > 20 ? `\n… +${lines.length - 20} more lines` : "";
      return (
        <pre className="font-mono text-[11px] leading-snug whitespace-pre-wrap break-all m-0 bg-green-950/40 text-green-300 p-1 rounded">
          {preview + more || " "}
        </pre>
      );
    }
    if (name === "Bash") {
      const cmd = str(input.command);
      const desc = str(input.description);
      return (
        <div>
          {desc && (
            <div className="text-terminal-muted text-[11px] italic mb-0.5">
              {desc}
            </div>
          )}
          <pre className="font-mono text-[11px] leading-snug whitespace-pre-wrap break-all m-0 bg-terminal-bg/60 text-terminal-text p-1 rounded">
            {cmd || " "}
          </pre>
        </div>
      );
    }
    return null;
  })();

  return (
    <div className="my-1 border-l-2 border-terminal-muted/40 pl-2">
      <div className="font-mono text-xs text-terminal-green">
        <span className="text-terminal-muted">●</span> {header}
      </div>
      {body && <div className="mt-1">{body}</div>}
    </div>
  );
}

function renderEventBody(evt: SseEvent, key: number) {
  if (evt.type === "tool" && evt.toolName) {
    return <ToolBlock key={key} name={evt.toolName} input={evt.toolInput ?? {}} />;
  }
  if (evt.type === "text") {
    return (
      <div
        key={key}
        className={`${eventClass(evt.type)} markdown`}
        dangerouslySetInnerHTML={renderHtml(evt)}
      />
    );
  }
  return (
    <div key={key} className={eventClass(evt.type)}>
      <span className="text-terminal-muted">{eventPrefix(evt.type)}</span>
      <span dangerouslySetInnerHTML={renderHtml(evt)} />
    </div>
  );
}

interface Turn {
  role: "user" | "desktop" | "assistant";
  items: { evt: SseEvent; idx: number }[];
}

const USER_PREFIX = "› ";
const DESKTOP_PREFIX = "🖥 ";

// Bookkeeping tools that get their own UI surface elsewhere (Tasks tab) —
// rendering them inline in the chat view is duplicate noise. Matches Claude
// Code TUI's own behaviour: it has a Tasks panel, the chat stream stays clean.
const SUPPRESSED_TOOLS = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "TaskStop",
  "TodoWrite",
]);

function groupIntoTurns(events: SseEvent[]): Turn[] {
  const turns: Turn[] = [];
  events.forEach((evt, idx) => {
    if (evt.type === "segment_end" || evt.type === "done") return;
    if (evt.type === "tool" && SUPPRESSED_TOOLS.has(evt.toolName ?? "")) return;
    if (evt.type === "text") {
      if (evt.content.startsWith(USER_PREFIX)) {
        const stripped: SseEvent = {
          ...evt,
          content: evt.content.slice(USER_PREFIX.length),
        };
        turns.push({ role: "user", items: [{ evt: stripped, idx }] });
        return;
      }
      if (evt.content.startsWith(DESKTOP_PREFIX)) {
        const stripped: SseEvent = {
          ...evt,
          content: evt.content.slice(DESKTOP_PREFIX.length),
        };
        turns.push({ role: "desktop", items: [{ evt: stripped, idx }] });
        return;
      }
    }
    const last = turns[turns.length - 1];
    if (!last || last.role !== "assistant") {
      turns.push({ role: "assistant", items: [{ evt, idx }] });
    } else {
      last.items.push({ evt, idx });
    }
  });
  return turns;
}

interface PaneTheme {
  label: string;
  border: string;
  headerBg: string;
  headerText: string;
  headerHover: string;
  headerBorderBottom: string;
}

const PANE_THEMES: Record<Turn["role"], PaneTheme> = {
  user: {
    label: "You",
    border: "border-terminal-green/30",
    headerBg: "bg-terminal-green/20",
    headerText: "text-terminal-green",
    headerHover: "hover:bg-terminal-green/25",
    headerBorderBottom: "border-terminal-green/25",
  },
  desktop: {
    label: "🖥 Desktop",
    border: "border-amber-400/25",
    headerBg: "bg-amber-500/15",
    headerText: "text-amber-300",
    headerHover: "hover:bg-amber-500/20",
    headerBorderBottom: "border-amber-400/20",
  },
  assistant: {
    label: "Claude",
    border: "border-sky-400/25",
    headerBg: "bg-sky-500/20",
    headerText: "text-sky-300",
    headerHover: "hover:bg-sky-500/25",
    headerBorderBottom: "border-sky-400/20",
  },
};

function turnPreview(turn: Turn): string {
  for (const { evt } of turn.items) {
    if (evt.type === "text" && evt.content) {
      const first = evt.content.split("\n")[0] ?? "";
      return first.length > 120 ? first.slice(0, 120) + "…" : first;
    }
  }
  return "";
}

export function Terminal({ events, streaming }: TerminalProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  const toggle = (ti: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(ti)) next.delete(ti);
      else next.add(ti);
      return next;
    });

  const turns = groupIntoTurns(events);

  return (
    <div className="flex-1 overflow-y-auto p-3 text-sm leading-snug">
      {turns.map((turn, ti) => {
        const isCollapsed = collapsed.has(ti);
        const theme = PANE_THEMES[turn.role];

        return (
          <div
            key={ti}
            className={`rounded-md border ${theme.border} bg-terminal-surface overflow-hidden ${ti === 0 ? "" : "mt-4"}`}
          >
            <button
              type="button"
              onClick={() => toggle(ti)}
              className={`${theme.headerBg} ${theme.headerText} ${theme.headerHover} border-b ${theme.headerBorderBottom} w-full flex items-center gap-2 px-3 py-1.5 text-[11px] uppercase tracking-wider font-semibold transition-colors cursor-pointer text-left`}
            >
              <span className="inline-block w-3 text-center">
                {isCollapsed ? "▶" : "▼"}
              </span>
              <span>{theme.label}</span>
              {isCollapsed && (
                <span className="normal-case font-normal text-terminal-muted truncate tracking-normal">
                  {turnPreview(turn)}
                </span>
              )}
            </button>
            {!isCollapsed && (
              <div className="px-3 py-2 space-y-1 text-[11px] leading-snug">
                {turn.role === "assistant" ? (
                  turn.items.map(({ evt, idx }) => renderEventBody(evt, idx))
                ) : (
                  <div className="text-terminal-text whitespace-pre-wrap">
                    {turn.items[0]!.evt.content}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {streaming && (
        <span className="inline-block w-2 h-4 bg-terminal-green animate-pulse" />
      )}
      <div ref={bottomRef} />
    </div>
  );
}
