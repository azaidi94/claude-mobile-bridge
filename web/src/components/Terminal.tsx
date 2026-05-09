import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { diffLines } from "diff";
import type { SseEvent } from "../api";
import { api } from "../api";

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

const DIFF_HEAD_ROWS = 50;

function ExpandToggle({
  expanded,
  onToggle,
  collapsedLabel,
}: {
  expanded: boolean;
  onToggle: () => void;
  collapsedLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="text-[11px] text-terminal-muted/80 hover:text-terminal-text mt-0.5 cursor-pointer"
    >
      {expanded ? "− collapse" : collapsedLabel}
    </button>
  );
}

function DiffLines({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => buildDiffRows(oldStr, newStr), [oldStr, newStr]);
  const overflow = rows.length > DIFF_HEAD_ROWS;
  const display = expanded || !overflow ? rows : rows.slice(0, DIFF_HEAD_ROWS);
  const hidden = rows.length - DIFF_HEAD_ROWS;
  return (
    <div>
      <pre className="font-mono text-[11px] leading-snug whitespace-pre-wrap break-all m-0 rounded overflow-hidden">
        {display.map((row, i) => {
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
      {overflow && (
        <ExpandToggle
          expanded={expanded}
          onToggle={() => setExpanded(!expanded)}
          collapsedLabel={`… +${hidden} lines (tap to expand)`}
        />
      )}
    </div>
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

const PROMOTE_ON_SUCCESS = new Set([
  "Bash",
  "Grep",
  "Glob",
  "Task",
  "Agent",
  "WebFetch",
  "WebSearch",
]);

/**
 * Show the first N lines of a multi-line text block with a
 * "… +N lines (tap to expand)" affordance. Mirrors Claude Code's
 * "ctrl+o to expand" pattern from the TUI — head, not tail, because for
 * generic command output the start is usually the structural context.
 */
function CollapsibleHead({
  content,
  headLines,
  bodyClass,
}: {
  content: string;
  headLines: number;
  bodyClass: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  if (lines.length <= headLines) {
    return <pre className={bodyClass}>{content}</pre>;
  }
  const display = expanded ? content : lines.slice(0, headLines).join("\n");
  const hidden = lines.length - headLines;
  return (
    <div>
      <pre className={bodyClass}>{display}</pre>
      <ExpandToggle
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        collapsedLabel={`… +${hidden} lines (tap to expand)`}
      />
    </div>
  );
}

/**
 * Show a head preview of a long string with a "+N chars (tap to expand)"
 * affordance. Used for error messages whose stack traces are huge.
 */
function CollapsibleText({
  content,
  previewChars,
  bodyClass,
}: {
  content: string;
  previewChars: number;
  bodyClass: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (content.length <= previewChars) {
    return <pre className={bodyClass}>{content}</pre>;
  }
  const display = expanded ? content : content.slice(0, previewChars) + "…";
  const hidden = content.length - previewChars;
  return (
    <div>
      <pre className={bodyClass}>{display}</pre>
      <ExpandToggle
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        collapsedLabel={`… +${hidden.toLocaleString()} chars (tap to expand)`}
      />
    </div>
  );
}

function ToolResultBody({
  name,
  result,
}: {
  name: string;
  result: { content: string; isError: boolean };
}) {
  // Errors always render — preview first 200 chars; full content available
  // on tap if the message is longer.
  if (result.isError) {
    return (
      <CollapsibleText
        content={result.content || "(no error message)"}
        previewChars={200}
        bodyClass="font-mono text-[11px] leading-snug whitespace-pre-wrap break-all m-0 bg-red-950/40 text-red-300 p-1 rounded"
      />
    );
  }

  // Success bodies: only render for promoted tools.
  if (!PROMOTE_ON_SUCCESS.has(name)) return null;

  if (name === "Bash") {
    return (
      <CollapsibleHead
        content={result.content}
        headLines={3}
        bodyClass="font-mono text-[11px] leading-snug whitespace-pre-wrap break-all m-0 bg-terminal-bg/60 text-terminal-text p-1 rounded"
      />
    );
  }

  if (name === "Grep" || name === "Glob") {
    const lineCount = result.content.split("\n").filter((l) => l.trim()).length;
    const label = name === "Grep" ? "matches" : "files";
    return (
      <ExpandableSummary
        summary={`Found ${lineCount} ${label}`}
        full={result.content}
      />
    );
  }

  if (name === "Task" || name === "Agent") {
    const m = result.content.match(
      /(\d+)\s*tool[_\s]?uses?.*?([\d.]+k?)\s*tokens?.*?([\d.]+s)/i,
    );
    const summary = m
      ? `Done · ${m[1]} tools · ${m[2]} tokens · ${m[3]}`
      : "Done";
    return <ExpandableSummary summary={summary} full={result.content} />;
  }

  if (name === "WebFetch" || name === "WebSearch") {
    return (
      <ExpandableSummary
        summary={`${result.content.length.toLocaleString()} chars returned`}
        full={result.content}
      />
    );
  }

  return null;
}

/**
 * One-line italic summary with a tap-to-reveal full body. Used for tools where
 * the summary is the headline (Grep count, Agent metrics, WebFetch byte count)
 * but you sometimes want to see the raw result content.
 */
function ExpandableSummary({
  summary,
  full,
}: {
  summary: string;
  full: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!full.trim()) {
    return (
      <div className="text-[11px] text-terminal-muted italic">{summary}</div>
    );
  }
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="text-[11px] text-terminal-muted italic hover:text-terminal-text cursor-pointer text-left"
      >
        {summary} {expanded ? "(tap to collapse)" : "(tap to expand)"}
      </button>
      {expanded && (
        <pre className="font-mono text-[11px] leading-snug whitespace-pre-wrap break-all m-0 bg-terminal-bg/60 text-terminal-text p-1 rounded mt-1">
          {full}
        </pre>
      )}
    </div>
  );
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
  result,
}: {
  name: string;
  input: Record<string, unknown>;
  result?: { content: string; isError: boolean };
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

  // Bullet colour reflects result state.
  const bulletCls = result
    ? result.isError
      ? "text-red-400"
      : "text-green-400"
    : "text-terminal-muted";

  return (
    <div className="my-1 border-l-2 border-terminal-muted/40 pl-2">
      <div className="font-mono text-xs text-terminal-green">
        <span className={bulletCls}>●</span> {header}
      </div>
      {body && <div className="mt-1">{body}</div>}
      {result && (
        <div className="mt-1">
          <ToolResultBody name={name} result={result} />
        </div>
      )}
    </div>
  );
}

function renderEventBody(
  evt: SseEvent,
  key: number,
  resultByToolUseId: Map<string, { content: string; isError: boolean }>,
) {
  if (evt.type === "tool" && evt.toolName) {
    if (SUPPRESSED_TOOLS.has(evt.toolName)) return null;
    const result = evt.toolUseId
      ? resultByToolUseId.get(evt.toolUseId)
      : undefined;
    return (
      <ToolBlock
        key={key}
        name={evt.toolName}
        input={evt.toolInput ?? {}}
        result={result}
      />
    );
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
  role: "user" | "desktop" | "assistant" | "remote";
  source?: "telegram" | "web" | "terminal" | "cursor";
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

function PermissionModeBanner({ events }: { events: SseEvent[] }) {
  // Find the latest permission_mode event in the stream.
  let latest: SseEvent["permissionMode"] | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "permission_mode") {
      latest = e.permissionMode;
      break;
    }
  }
  if (!latest || latest === "default") return null;
  const labels: Record<string, { text: string; cls: string }> = {
    plan: {
      text: "📋 Plan mode — agent will not modify files",
      cls: "bg-yellow-500/15 border-yellow-400/40 text-yellow-300",
    },
    acceptEdits: {
      text: "✅ Auto-accept edits",
      cls: "bg-green-500/15 border-green-400/40 text-green-300",
    },
    bypassPermissions: {
      text: "⚙ Bypass permissions",
      cls: "bg-terminal-muted/15 border-terminal-muted/40 text-terminal-muted",
    },
  };
  const conf = labels[latest];
  if (!conf) return null;
  return (
    <div className={`px-2 py-1 text-[11px] border ${conf.cls} rounded mb-2`}>
      {conf.text}
    </div>
  );
}

interface AskOpenRecord {
  askId: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  allowCustom: boolean;
}

/**
 * Walk the event log and return only the asks that are still open — every
 * ask_remote adds, every matching ask_remote_cleared (or duplicate ask_id)
 * removes. Renders bottom-up so newest open question is at the bottom.
 */
function collectOpenAsks(events: SseEvent[]): AskOpenRecord[] {
  const open = new Map<string, AskOpenRecord>();
  for (const e of events) {
    if (e.type === "ask_remote" && e.askId) {
      open.set(e.askId, {
        askId: e.askId,
        question: e.askQuestion ?? e.content,
        options: e.askOptions ?? [],
        allowCustom: e.askAllowCustom !== false,
      });
    } else if (e.type === "ask_remote_cleared" && e.askId) {
      open.delete(e.askId);
    }
  }
  return [...open.values()];
}

function AskRemoteCard({ ask }: { ask: AskOpenRecord }) {
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [customText, setCustomText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (answer: string, marker: string) => {
    if (submitting) return;
    setSubmitting(marker);
    setError(null);
    try {
      const res = await api.submitAskRemoteAnswer(ask.askId, answer);
      if (!res.ok) {
        setError(res.error ?? "failed to submit");
        setSubmitting(null);
      }
      // On success the bus emits ask_remote_cleared which removes this card.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(null);
    }
  };

  const cancel = async () => {
    if (submitting) return;
    setSubmitting("cancel");
    setError(null);
    try {
      const res = await api.cancelAskRemote(ask.askId);
      if (!res.ok) {
        setError(res.error ?? "failed to cancel");
        setSubmitting(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(null);
    }
  };

  return (
    <div className="mt-4 rounded-md border border-amber-400/40 bg-amber-500/10 overflow-hidden">
      <div className="px-3 py-1.5 bg-amber-500/20 text-amber-200 text-[11px] uppercase tracking-wider font-semibold border-b border-amber-400/30">
        ❓ Claude is asking
      </div>
      <div className="px-3 py-2 text-sm text-terminal-text">
        <div className="font-medium mb-2">{ask.question}</div>
        <div className="space-y-2">
          {ask.options.map((o, i) => {
            const marker = `opt:${i}`;
            const busy = submitting === marker;
            return (
              <button
                key={i}
                type="button"
                disabled={submitting !== null}
                onClick={() => submit(o.label, marker)}
                className={`w-full text-left rounded border border-terminal-muted/30 px-2 py-1.5 hover:border-amber-400/60 hover:bg-amber-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors`}
              >
                <span className="font-medium text-terminal-text">
                  {busy ? "submitting…" : `${i + 1}. ${o.label}`}
                </span>
                {o.description && (
                  <div className="text-[11px] text-terminal-muted mt-0.5">
                    {o.description}
                  </div>
                )}
              </button>
            );
          })}
        </div>
        {ask.allowCustom && (
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              placeholder="Or type a custom answer…"
              disabled={submitting !== null}
              className="flex-1 rounded bg-terminal-bg border border-terminal-muted/30 px-2 py-1 text-sm focus:outline-none focus:border-amber-400/60 disabled:opacity-50"
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  customText.trim() &&
                  !submitting
                ) {
                  e.preventDefault();
                  submit(customText.trim(), "custom");
                }
              }}
            />
            <button
              type="button"
              disabled={!customText.trim() || submitting !== null}
              onClick={() => submit(customText.trim(), "custom")}
              className="rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 px-3 py-1 text-sm text-amber-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Send
            </button>
          </div>
        )}
        <div className="mt-2 flex items-center justify-between text-[11px]">
          <button
            type="button"
            disabled={submitting !== null}
            onClick={cancel}
            className="text-terminal-muted hover:text-amber-300 transition-colors disabled:opacity-50"
          >
            ✖ Cancel
          </button>
          {error && <span className="text-red-400">{error}</span>}
        </div>
      </div>
    </div>
  );
}

function HookSummaryCard({ event }: { event: SseEvent }) {
  if (event.type !== "hook_summary" || !event.hook) return null;
  const h = event.hook;
  return (
    <div className="my-2 px-2 py-1 border border-red-400/40 bg-red-950/30 rounded text-[11px]">
      <div className="text-red-300 font-semibold">
        🪝 stop hook
        {h.failingHookName ? ` ${h.failingHookName}` : ""}
        {h.preventedContinuation ? " blocked the run" : " failed"}
      </div>
      {h.firstError && (
        <div className="text-terminal-text mt-1 whitespace-pre-wrap">
          {h.firstError.slice(0, 200)}
        </div>
      )}
    </div>
  );
}

function groupIntoTurns(events: SseEvent[]): Turn[] {
  const turns: Turn[] = [];
  events.forEach((evt, idx) => {
    if (evt.type === "segment_end" || evt.type === "done") return;
    if (evt.type === "tool_result") return; // correlated to tool, not its own row
    if (evt.type === "permission_mode") return; // banner (Task 10)
    if (evt.type === "hook_summary") return; // inline card (Task 10)
    if (evt.type === "ask_remote") return; // dedicated card below
    if (evt.type === "ask_remote_cleared") return; // bookkeeping only
    if (evt.type === "tool" && SUPPRESSED_TOOLS.has(evt.toolName ?? "")) return;
    if (evt.type === "user_message") {
      turns.push({ role: "remote", source: evt.source, items: [{ evt, idx }] });
      return;
    }
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
    // Carry the source onto assistant turns so cursor AI replies can be
    // labelled "🤖 Cursor AI" instead of "Claude". Don't merge across
    // sources — a cursor AI reply mid-conversation shouldn't fold into
    // a preceding Claude turn.
    const evtSource = (evt as { source?: Turn["source"] }).source;
    if (!last || last.role !== "assistant" || last.source !== evtSource) {
      turns.push({ role: "assistant", source: evtSource, items: [{ evt, idx }] });
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
    label: "🤖 Claude",
    border: "border-sky-400/25",
    headerBg: "bg-sky-500/20",
    headerText: "text-sky-300",
    headerHover: "hover:bg-sky-500/25",
    headerBorderBottom: "border-sky-400/20",
  },
  remote: {
    label: "Remote",
    border: "border-violet-400/25",
    headerBg: "bg-violet-500/15",
    headerText: "text-violet-300",
    headerHover: "hover:bg-violet-500/20",
    headerBorderBottom: "border-violet-400/20",
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

function sourceLabel(source?: string): string {
  if (source === "telegram") return "📱 Telegram";
  if (source === "cursor") return "🖱 Cursor";
  if (source === "web") return "🌐 Web UI";
  if (source === "terminal") return "🖥 Terminal";
  return "🖥 Terminal"; // safe fallback (unknown source treated as terminal)
}

/** Pick a header label for a turn, accounting for assistant-with-source. */
function turnLabel(turn: Turn, defaultLabel: string): string {
  if (turn.role === "remote") return sourceLabel(turn.source);
  if (turn.role === "assistant" && turn.source === "cursor") return "🤖 Cursor AI";
  return defaultLabel;
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

  // Correlate tool_result events to their tool_use by toolUseId.
  const resultByToolUseId = new Map<
    string,
    { content: string; isError: boolean }
  >();
  for (const evt of events) {
    if (evt.type === "tool_result" && evt.toolUseId) {
      resultByToolUseId.set(evt.toolUseId, {
        content: evt.content,
        isError: Boolean(evt.isError),
      });
    }
  }

  const turns = groupIntoTurns(events);

  return (
    <div className="flex-1 overflow-y-auto p-3 text-sm leading-snug">
      <PermissionModeBanner events={events} />
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
              <span>{turnLabel(turn, theme.label)}</span>
              {isCollapsed && (
                <span className="normal-case font-normal text-terminal-muted truncate tracking-normal">
                  {turnPreview(turn)}
                </span>
              )}
            </button>
            {!isCollapsed && (
              <div className="px-3 py-2 space-y-1 text-[11px] leading-snug">
                {turn.role === "assistant" ? (
                  turn.items.map(({ evt, idx }) => renderEventBody(evt, idx, resultByToolUseId))
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
      {events
        .filter((e) => e.type === "hook_summary")
        .map((e, i) => (
          <HookSummaryCard key={`hook-${i}`} event={e} />
        ))}
      {collectOpenAsks(events).map((ask) => (
        <AskRemoteCard key={ask.askId} ask={ask} />
      ))}
      {streaming && (
        <span className="inline-block w-2 h-4 bg-terminal-green animate-pulse" />
      )}
      <div ref={bottomRef} />
    </div>
  );
}
