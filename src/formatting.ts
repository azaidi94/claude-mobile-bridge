/**
 * Formatting module for Claude Telegram Bot.
 *
 * Markdown conversion and tool status display formatting.
 */

import type { AskUserQuestionItem } from "./types";

/**
 * Escape HTML special characters.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Convert standard markdown to Telegram-compatible HTML.
 *
 * HTML is more reliable than Telegram's Markdown which breaks on special chars.
 * Telegram HTML supports: <b>, <i>, <code>, <pre>, <a href="">
 */
export function convertMarkdownToHtml(text: string): string {
  // Store code blocks temporarily to avoid processing their contents
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];
  const tableBlocks: string[] = [];

  // Code blocks must be stashed BEFORE table extraction. extractMarkdownTables
  // is line-based with no fence awareness, so a `| col |` row inside a fenced
  // code block would otherwise be matched as a real table — restoration then
  // produces nested <pre><pre>…</pre></pre> which Telegram rejects with
  // "Bad Request: can't parse entities" (bug_002 from review).

  // Save code blocks first (```code```)
  text = text.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  // Save inline code (`code`)
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(code);
    return `\x00INLINECODE${inlineCodes.length - 1}\x00`;
  });

  // Save markdown tables — Telegram HTML has no <table> support, so we wrap
  // them in <pre> at the end to preserve column alignment. Now safe because
  // anything inside a code fence is already a placeholder.
  text = extractMarkdownTables(text, tableBlocks);

  // Escape HTML entities in the remaining text
  text = escapeHtml(text);

  // Bold: **text** -> <b>text</b>
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Double underscore: __text__ -> <b>text</b>
  text = text.replace(/__([^_\n]+)__/g, "<b>$1</b>");

  // Italic: *text* -> <i>text</i>
  // Require content to start/end with non-space to avoid matching "2 * 3 = 6"
  text = text.replace(
    /(?<![a-zA-Z0-9*])\*(\S(?:[^*\n]*\S)?)\*(?![a-zA-Z0-9*])/g,
    "<i>$1</i>",
  );

  // Italic: _text_ -> <i>text</i> (only when surrounded by non-word chars)
  text = text.replace(
    /(?<![a-zA-Z0-9_])_(\S(?:[^_\n]*\S)?)_(?![a-zA-Z0-9_])/g,
    "<i>$1</i>",
  );

  // Headers: ## Header -> <b>Header</b>
  // Run after inline formatting so **bold** inside headers is already converted.
  // Strip inner <b> tags to prevent nested <b> which Telegram rejects.
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_, content) => {
    const flat = content.replace(/<b>([^<]*)<\/b>/g, "$1");
    return `<b>${flat}</b>\n`;
  });

  // Blockquotes: &gt; text -> <blockquote>text</blockquote>
  text = convertBlockquotes(text);

  // Bullet lists: - item or * item -> • item
  text = text.replace(/^[-*] /gm, "• ");

  // Horizontal rules: --- or *** -> blank line
  text = text.replace(/^[-*]{3,}$/gm, "");

  // Links: [text](url) -> <a href="url">text</a>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    const escapedCode = escapeHtml(codeBlocks[i]!);
    text = text.replace(`\x00CODEBLOCK${i}\x00`, `<pre>${escapedCode}</pre>`);
  }

  // Restore tables as preformatted blocks (column alignment preserved
  // by monospace rendering; Telegram doesn't support real tables).
  for (let i = 0; i < tableBlocks.length; i++) {
    const rendered = renderTableAsPre(tableBlocks[i]!);
    text = text.replace(`\x00TABLE${i}\x00`, rendered);
  }

  // Restore inline code
  for (let i = 0; i < inlineCodes.length; i++) {
    const escapedCode = escapeHtml(inlineCodes[i]!);
    text = text.replace(
      `\x00INLINECODE${i}\x00`,
      `<code>${escapedCode}</code>`,
    );
  }

  // Collapse multiple newlines
  text = text.replace(/\n{3,}/g, "\n\n");

  return text;
}

/**
 * Detect GFM-style markdown tables and replace them with placeholders,
 * stashing the raw block in `out`. Identifies a table by a row that
 * starts and ends with `|`, immediately followed by a separator row of
 * the form `|---|---|...` (with optional `:` for alignment).
 */
function extractMarkdownTables(text: string, out: string[]): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const next = lines[i + 1] ?? "";
    if (isTableRow(line) && isTableSeparator(next)) {
      const block: string[] = [line, next];
      i += 2;
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        block.push(lines[i]!);
        i++;
      }
      const placeholder = `\x00TABLE${out.length}\x00`;
      out.push(block.join("\n"));
      result.push(placeholder);
      continue;
    }
    result.push(line);
    i++;
  }
  return result.join("\n");
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false;
  return /^\|[\s\-:|]+\|$/.test(trimmed) && trimmed.includes("-");
}

/**
 * Pretty-print a markdown table block as a monospace `<pre>` with
 * column-aligned cells. Bold formatting in cells (e.g. `**name**`) is
 * stripped — Telegram's <pre> doesn't allow inline tags.
 */
function renderTableAsPre(block: string): string {
  const lines = block.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return "";

  const rows: string[][] = lines
    .filter((l) => !isTableSeparator(l))
    .map((l) => {
      // Strip leading/trailing pipe, then split, then trim each cell.
      const inner = l.trim().replace(/^\|/, "").replace(/\|$/, "");
      return inner
        .split("|")
        .map((cell) => cell.trim().replace(/\*\*(.+?)\*\*/g, "$1"));
    });

  if (rows.length === 0) return "";

  const colCount = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    widths[c] = Math.max(...rows.map((r) => (r[c] ?? "").length));
  }

  const formatted = rows
    .map((r) =>
      r
        .map((cell, c) => cell.padEnd(widths[c] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");

  return `<pre>${escapeHtml(formatted)}</pre>`;
}

/**
 * Convert blockquotes (handles multi-line).
 */
function convertBlockquotes(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inBlockquote = false;
  const blockquoteLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("&gt; ") || line === "&gt;") {
      if (line === "&gt;") {
        blockquoteLines.push("");
      } else {
        // Remove '&gt; ' and strip # from hashtags (Telegram mobile bug workaround)
        const content = line.slice(5).replace(/#/g, "");
        blockquoteLines.push(content);
      }
      inBlockquote = true;
    } else {
      if (inBlockquote) {
        result.push(
          "<blockquote>" + blockquoteLines.join("\n") + "</blockquote>",
        );
        blockquoteLines.length = 0;
        inBlockquote = false;
      }
      result.push(line);
    }
  }

  // Handle blockquote at end
  if (inBlockquote) {
    result.push("<blockquote>" + blockquoteLines.join("\n") + "</blockquote>");
  }

  return result.join("\n");
}

// ============== Tool Status Formatting ==============

/**
 * Shorten a file path for display (last 2 components).
 */
function shortenPath(path: string): string {
  if (!path) return "file";
  const parts = path.split("/");
  if (parts.length >= 2) {
    return parts.slice(-2).join("/");
  }
  return parts[parts.length - 1] || path;
}

/**
 * Truncate text with ellipsis.
 */
export function truncate(text: string, maxLen = 60): string {
  if (!text) return "";
  // Clean up newlines for display
  const cleaned = text.replace(/\n/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + "...";
}

/**
 * Wrap text in HTML code tags, escaping special chars.
 */
function code(text: string): string {
  return `<code>${escapeHtml(text)}</code>`;
}

/**
 * Format tool use for display in Telegram with HTML formatting.
 */
export function formatToolStatus(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  const emojiMap: Record<string, string> = {
    Read: "📖",
    Write: "📝",
    Edit: "✏️",
    Bash: "▶️",
    Glob: "🔍",
    Grep: "🔎",
    WebSearch: "🔍",
    WebFetch: "🌐",
    Task: "🎯",
    Agent: "🎯",
    TodoWrite: "📋",
    mcp__: "🔧",
  };

  // Find matching emoji
  let emoji = "🔧";
  for (const [key, val] of Object.entries(emojiMap)) {
    if (toolName.includes(key)) {
      emoji = val;
      break;
    }
  }

  // Helper: wrap in italic for background/low-signal tools
  const dim = (s: string) => `<i>${s}</i>`;

  // Format based on tool type
  if (toolName === "Read") {
    const filePath = String(toolInput.file_path || "file");
    const shortPath = shortenPath(filePath);
    const imageExtensions = [
      ".jpg",
      ".jpeg",
      ".png",
      ".gif",
      ".webp",
      ".bmp",
      ".svg",
      ".ico",
    ];
    if (imageExtensions.some((ext) => filePath.toLowerCase().endsWith(ext))) {
      return dim("👀 Viewing");
    }
    return dim(`${emoji} Reading ${code(shortPath)}`);
  }

  if (toolName === "Write") {
    const filePath = String(toolInput.file_path || "file");
    return dim(`${emoji} Writing ${code(shortenPath(filePath))}`);
  }

  if (toolName === "Edit") {
    const filePath = String(toolInput.file_path || "file");
    return dim(`${emoji} Editing ${code(shortenPath(filePath))}`);
  }

  if (toolName === "Bash") {
    const cmd = String(toolInput.command || "");
    const desc = String(toolInput.description || "");
    if (desc) {
      return dim(`${emoji} ${escapeHtml(desc)}`);
    }
    return dim(`${emoji} ${code(truncate(cmd, 50))}`);
  }

  if (toolName === "Grep") {
    const pattern = String(toolInput.pattern || "");
    const path = String(toolInput.path || "");
    if (path) {
      return dim(
        `${emoji} Searching ${code(truncate(pattern, 30))} in ${code(shortenPath(path))}`,
      );
    }
    return dim(`${emoji} Searching ${code(truncate(pattern, 40))}`);
  }

  if (toolName === "Glob") {
    const pattern = String(toolInput.pattern || "");
    return dim(`${emoji} Finding ${code(truncate(pattern, 50))}`);
  }

  if (toolName === "WebSearch") {
    const query = String(toolInput.query || "");
    return dim(`${emoji} Searching: ${escapeHtml(truncate(query, 50))}`);
  }

  if (toolName === "WebFetch") {
    const url = String(toolInput.url || "");
    return dim(`${emoji} Fetching ${code(truncate(url, 50))}`);
  }

  // Agent/task tools — bold so they stand out from file noise
  if (toolName === "Task" || toolName === "Agent") {
    const desc = String(toolInput.description || "");
    if (desc) {
      return `${emoji} <b>Agent:</b> ${escapeHtml(truncate(desc, 60))}`;
    }
    return `${emoji} <b>Running agent...</b>`;
  }

  if (toolName === "TaskCreate") {
    const desc = String(toolInput.description || "");
    return desc
      ? `📋 <b>Task:</b> ${escapeHtml(truncate(desc, 60))}`
      : `📋 <b>Creating task...</b>`;
  }

  if (toolName === "TaskUpdate") {
    const status = String(toolInput.status || "");
    const desc = String(toolInput.description || "");
    const label = desc
      ? escapeHtml(truncate(desc, 50))
      : `task ${String(toolInput.id || "").slice(0, 8)}`;
    const statusIcon: Record<string, string> = {
      completed: "✅",
      in_progress: "⏳",
      cancelled: "❌",
      pending: "⏸",
    };
    const icon = statusIcon[status] || "📋";
    return status
      ? `${icon} <b>${escapeHtml(status)}:</b> ${label}`
      : `📋 <b>Update:</b> ${label}`;
  }

  if (toolName === "TaskGet" || toolName === "TaskList") {
    return dim(`📋 Checking tasks`);
  }

  if (toolName === "TaskStop") {
    return `⏹ <b>Stopping task</b>`;
  }

  if (toolName === "Skill") {
    const skillName = String(toolInput.skill || "");
    if (skillName) {
      return `💭 <b>Skill:</b> ${escapeHtml(skillName)}`;
    }
    return dim(`💭 Using skill...`);
  }

  if (toolName.startsWith("mcp__")) {
    // Generic MCP tool formatting
    const parts = toolName.split("__");
    if (parts.length >= 3) {
      const server = parts[1]!;
      let action = parts[2]!;
      // Remove redundant server prefix from action
      if (action.startsWith(`${server}_`)) {
        action = action.slice(server.length + 1);
      }
      action = action.replace(/_/g, " ");

      // Try to get meaningful summary
      const summary =
        toolInput.title ||
        toolInput.query ||
        toolInput.content ||
        toolInput.text ||
        toolInput.id ||
        "";

      if (summary) {
        return `🔧 ${server} ${action}: ${escapeHtml(
          truncate(String(summary), 40),
        )}`;
      }
      return `🔧 ${server}: ${action}`;
    }
    return `🔧 ${escapeHtml(toolName)}`;
  }

  return `${emoji} ${escapeHtml(toolName)}`;
}

/**
 * Format a combined "tool + result" message for Telegram. Called by the watch
 * handler when a tool_result arrives for a promoted tool or any errored tool.
 */
export function formatToolResultSummary(
  toolName: string | undefined,
  resultContent: string,
  isError: boolean,
): string {
  const safeName = toolName ?? "tool";
  if (isError) {
    return `❌ <b>${escapeHtml(safeName)}</b>: ${escapeHtml(truncate(resultContent, 200))}`;
  }
  if (toolName === "Bash") {
    // Bash output ends with "\n"; strip it so lastLine is the real tail.
    const trimmed = resultContent.replace(/\n+$/, "");
    const lines = trimmed.split("\n");
    const lastLine = lines[lines.length - 1] ?? "";
    const more = lines.length > 1 ? ` (+${lines.length - 1} lines)` : "";
    return `▶️ <b>Bash</b>: ${code(truncate(lastLine, 80))}${more}`;
  }
  if (toolName === "Grep" || toolName === "Glob") {
    const count = resultContent.split("\n").filter((l) => l.trim()).length;
    const label = toolName === "Grep" ? "matches" : "files";
    return `🔎 <b>${toolName}</b>: ${count} ${label}`;
  }
  if (toolName === "Task" || toolName === "Agent") {
    const m = resultContent.match(
      /(\d+)\s*tool[_\s]?uses?.*?([\d.]+k?)\s*tokens?.*?([\d.]+s)/i,
    );
    return m
      ? `🎯 <b>${toolName} done</b>: ${m[1]} tools · ${m[2]} tokens · ${m[3]}`
      : `🎯 <b>${toolName} done</b>`;
  }
  if (toolName === "WebFetch" || toolName === "WebSearch") {
    return `🌐 <b>${toolName}</b>: ${resultContent.length.toLocaleString()} chars returned`;
  }
  // Unknown promoted tool: generic "done".
  return `✅ <b>${escapeHtml(safeName)}</b>: ${escapeHtml(truncate(resultContent, 80))}`;
}

const LOCAL_COMMAND_CAVEAT_RE =
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g;

/**
 * Strip Claude Code's `<local-command-caveat>` injection — a disclaimer CC
 * prepends to user content captured during local-command (`!`-prefix) runs.
 * Pure system noise; nothing to render in TG or the Web UI. Returns the
 * caller's text with caveat tags removed and trimmed; empty string means
 * the entry was entirely caveat.
 */
export function stripLocalCommandCaveat(text: string): string {
  if (!text.includes("<local-command-caveat>")) return text.trim();
  return text.replace(LOCAL_COMMAND_CAVEAT_RE, "").trim();
}

/**
 * Pretty-print Claude Code's `<task-notification>` injection (background-task
 * status that Claude reinjects as user-prompt content). Returns formatted HTML,
 * or `null` if the text doesn't contain a notification — caller falls back to
 * its normal markdown path.
 */
export function formatTaskNotification(text: string): string | null {
  if (!text.includes("<task-notification>")) return null;

  const statusIcon: Record<string, string> = {
    completed: "✅",
    failed: "❌",
    error: "❌",
    running: "⏳",
    killed: "⏹",
    cancelled: "⏹",
    timeout: "⏱",
  };

  const replaced = text.replace(
    /<task-notification>([\s\S]*?)<\/task-notification>/g,
    (_full, inner: string) => {
      const get = (tag: string): string => {
        const m = inner.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
        return m ? m[1]!.trim() : "";
      };
      const status = get("status").toLowerCase();
      const summary = get("summary");
      const eventDetail = get("event");
      const icon = statusIcon[status] ?? "🔔";
      const label = status ? `Task ${status}` : "Task update";
      const lines = [`${icon} <b>${escapeHtml(label)}</b>`];
      if (summary) lines.push(`<i>${escapeHtml(truncate(summary, 280))}</i>`);
      if (eventDetail) lines.push(escapeHtml(truncate(eventDetail, 800)));
      return lines.join("\n");
    },
  );

  return replaced.trim();
}

const ASK_USER_QUESTION_PREVIEW_MAX = 600;
const ASK_USER_QUESTION_CARD_MAX = 3800;
const ASK_USER_QUESTION_TRUNC_FOOTER =
  "<i>(card truncated — see desktop for full options)</i>";

/**
 * Format Claude's built-in `AskUserQuestion` tool call as a Telegram HTML
 * card. Render-only — answering still happens at the desktop's native picker.
 */
export function formatAskUserQuestion(
  questions: AskUserQuestionItem[],
): string {
  const header = "❓ <b>Claude is asking</b>";
  const footer = "<i>Answer at the desktop.</i>";

  if (!questions || questions.length === 0) {
    return `${header}\n\n<i>(no options visible)</i>\n\n${footer}`;
  }

  const blocks: string[] = [];
  let truncated = false;
  // Reserve headroom for the truncation footer up front so the cap holds
  // even when we end up appending it.
  let runningLen =
    header.length +
    2 +
    footer.length +
    2 +
    ASK_USER_QUESTION_TRUNC_FOOTER.length +
    2;

  for (const item of questions) {
    const lines: string[] = [];
    if (item.header) {
      lines.push(`<i>[${escapeHtml(item.header)}]</i>`);
    }
    const multi = item.multiSelect ? " <i>(pick any)</i>" : "";
    lines.push(`<b>Q:</b> ${escapeHtml(item.question)}${multi}`);
    for (const opt of item.options ?? []) {
      const label = `<b>${escapeHtml(opt.label)}</b>`;
      const desc = opt.description ? ` — ${escapeHtml(opt.description)}` : "";
      lines.push(`   • ${label}${desc}`);
      if (opt.preview) {
        // Cap the *escaped* length so HTML-special-heavy previews can't blow
        // past the budget (e.g. 600 raw `<` → 2400 escaped chars).
        const escaped = escapeHtml(opt.preview);
        let safe = escaped;
        if (escaped.length > ASK_USER_QUESTION_PREVIEW_MAX) {
          let cut = ASK_USER_QUESTION_PREVIEW_MAX;
          // Don't split an HTML entity (e.g. `&am|p;`) — back off to the `&`.
          const ampAt = escaped.lastIndexOf("&", cut);
          if (ampAt >= 0 && escaped.indexOf(";", ampAt) >= cut) cut = ampAt;
          safe = escaped.slice(0, cut) + "…";
        }
        lines.push(`     <pre>${safe}</pre>`);
      }
    }

    const block = lines.join("\n");
    const sep = blocks.length === 0 ? 0 : 2;
    // Always include the first block so we never send an empty body, even
    // if a single oversized question exceeds the cap on its own.
    if (
      blocks.length > 0 &&
      runningLen + sep + block.length > ASK_USER_QUESTION_CARD_MAX
    ) {
      truncated = true;
      break;
    }
    blocks.push(block);
    runningLen += sep + block.length;
  }

  const body = blocks.join("\n\n");
  const truncNote = truncated ? `\n\n${ASK_USER_QUESTION_TRUNC_FOOTER}` : "";
  return `${header}\n\n${body}${truncNote}\n\n${footer}`;
}

/**
 * Render a 10-cell progress bar. Glyphs are customizable so different surfaces
 * (usage panel, context bar) can share the clamp/round math but keep their look.
 */
export function progressBar(
  pct: number,
  { filled = "█", empty = "░" }: { filled?: string; empty?: string } = {},
): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const n = Math.round(clamped / 10);
  return filled.repeat(n) + empty.repeat(10 - n);
}

/**
 * Format a timestamp as relative time (e.g. "5m ago").
 */
export function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}
