/**
 * Formatting module for Claude Telegram Bot.
 *
 * Markdown conversion and tool status display formatting.
 */

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
function truncate(text: string, maxLen = 60): string {
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
