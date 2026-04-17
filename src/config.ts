/**
 * Configuration for Claude Telegram Bot.
 *
 * All environment variables, paths, constants, and safety settings.
 */

import { homedir } from "os";
import { resolve, dirname } from "path";
import { mkdir } from "fs/promises";
import type { McpServerConfig } from "./types";
import { debug, warn, error as logError } from "./logger";

// ============== Environment Setup ==============

const HOME = homedir();

// Ensure necessary paths are available for Claude's bash commands
// LaunchAgents don't inherit the full shell environment
const EXTRA_PATHS = [
  `${HOME}/.local/bin`,
  `${HOME}/.bun/bin`,
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
];

const currentPath = process.env.PATH || "";
const pathParts = currentPath.split(":");
for (const extraPath of EXTRA_PATHS) {
  if (!pathParts.includes(extraPath)) {
    pathParts.unshift(extraPath);
  }
}
process.env.PATH = pathParts.join(":");

// ============== Core Configuration ==============

export const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const ALLOWED_USERS: number[] = (
  process.env.TELEGRAM_ALLOWED_USERS || ""
)
  .split(",")
  .filter((x) => x.trim())
  .map((x) => parseInt(x.trim(), 10))
  .filter((x) => !isNaN(x));

export const WORKING_DIR = process.env.CLAUDE_WORKING_DIR || HOME;

// The bot's own source directory — never auto-watch this session
export const BOT_DIR = dirname(import.meta.dir);
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// ============== Claude CLI Path ==============

// Auto-detect from PATH, or use environment override
export function findClaudeCli(): string {
  const envPath = process.env.CLAUDE_CLI_PATH;
  if (envPath) return envPath;

  // Try to find claude in PATH using Bun.which
  const whichResult = Bun.which("claude");
  if (whichResult) return whichResult;

  // Final fallback
  return "/usr/local/bin/claude";
}

export const CLAUDE_CLI_PATH = findClaudeCli();

/** Set to `1` in tests so desktop spawn logic runs without macOS. */
const DESKTOP_SPAWN_TEST =
  process.env.TELEGRAM_BOT_DESKTOP_SPAWN_ANY_PLATFORM === "1";

/** `/new` and `/sessions` → Resume open a local Terminal window (macOS only). */
export function isDesktopClaudeSpawnSupported(): boolean {
  return process.platform === "darwin" || DESKTOP_SPAWN_TEST;
}

/**
 * Desktop terminal used by `/new` and `/sessions` → Resume.
 *   - `terminal` (default) — macOS Terminal.app via AppleScript
 *   - `iterm2`             — iTerm2 via AppleScript
 *   - `ghostty`            — Ghostty.app via `open -na --args -e`
 *   - `cmux`               — cmux.app via `cmux new-workspace` (must be running)
 */
export type TerminalApp = "terminal" | "iterm2" | "ghostty" | "cmux";

export function parseTerminalApp(raw: string): TerminalApp {
  const v = raw.trim().toLowerCase();
  if (v === "iterm" || v === "iterm2") return "iterm2";
  if (v === "ghostty") return "ghostty";
  if (v === "cmux") return "cmux";
  if (v === "" || v === "terminal") return "terminal";
  warn(
    `config: unknown DESKTOP_TERMINAL_APP "${raw}", falling back to Terminal`,
  );
  return "terminal";
}

export const DESKTOP_TERMINAL_APP: TerminalApp = parseTerminalApp(
  process.env.DESKTOP_TERMINAL_APP || "Terminal",
);

/**
 * Extra arguments passed to `claude` when opening a desktop session (channel relay).
 * Override if your relay name differs.
 *
 * NB: only pass `--dangerously-load-development-channels` — passing the extra
 * `--channels server:channel-relay` flag causes Claude Code to also try
 * registering the channel via the *approved* allowlist path, producing a
 * "not on the approved channels allowlist" warning AND listing the channel
 * twice in the UI. The dangerous flag alone both approves and starts listening.
 *
 * `--dangerously-skip-permissions` is included so headless /new sessions
 * (no human at the Mac) don't block on per-tool approval prompts.
 */
export const DESKTOP_CLAUDE_DEFAULT_ARGS =
  process.env.DESKTOP_CLAUDE_ARGS?.trim() ||
  "--dangerously-skip-permissions --dangerously-load-development-channels server:channel-relay";

/**
 * Optional shell command template for desktop spawn; `{dir}` is replaced with a
 * single-quoted project path. If unset, the bot runs:
 * `cd <dir> && exec <CLAUDE_CLI_PATH> <DESKTOP_CLAUDE_DEFAULT_ARGS>`.
 */
export const DESKTOP_CLAUDE_COMMAND_TEMPLATE =
  process.env.DESKTOP_CLAUDE_COMMAND?.trim() || "";

// ============== MCP Configuration ==============

// MCP servers loaded from mcp-config.ts
let MCP_SERVERS: Record<string, McpServerConfig> = {};

try {
  // Dynamic import of MCP config
  const mcpConfigPath = resolve(dirname(import.meta.dir), "mcp-config.ts");
  const mcpModule = await import(mcpConfigPath).catch(() => null);
  if (mcpModule?.MCP_SERVERS) {
    MCP_SERVERS = mcpModule.MCP_SERVERS;
    debug(`mcp: ${Object.keys(MCP_SERVERS).length} servers`);
  }
} catch {
  debug("mcp: none configured");
}

export { MCP_SERVERS };

// ============== Security Configuration ==============

// Allowed directories for file operations
const defaultAllowedPaths = [
  WORKING_DIR,
  `${HOME}/Documents`,
  `${HOME}/Downloads`,
  `${HOME}/Desktop`,
  `${HOME}/.claude`, // Claude Code data (plans, settings)
];

const allowedPathsStr = process.env.ALLOWED_PATHS || "";
export const ALLOWED_PATHS: string[] = allowedPathsStr
  ? allowedPathsStr
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
  : defaultAllowedPaths;

// Build safety prompt dynamically from ALLOWED_PATHS
function buildSafetyPrompt(allowedPaths: string[]): string {
  const pathsList = allowedPaths
    .map((p) => `   - ${p} (and subdirectories)`)
    .join("\n");

  return `
CRITICAL SAFETY RULES FOR TELEGRAM BOT:

1. NEVER delete, remove, or overwrite files without EXPLICIT confirmation from the user.
   - If user asks to delete something, respond: "Are you sure you want to delete [file]? Reply 'yes delete it' to confirm."
   - Only proceed with deletion if user replies with explicit confirmation like "yes delete it", "confirm delete"
   - This applies to: rm, trash, unlink, shred, or any file deletion

2. You can ONLY access files in these directories:
${pathsList}
   - REFUSE any file operations outside these paths

3. NEVER run dangerous commands like:
   - rm -rf (recursive force delete)
   - Any command that affects files outside allowed directories
   - Commands that could damage the system

4. For any destructive or irreversible action, ALWAYS ask for confirmation first.

You are running via Telegram, so the user cannot easily undo mistakes. Be extra careful!

5. SENDING FILES TO THE USER:
   When the user asks you to send them a file, include this directive in your response:
   <<SEND_FILE:/absolute/path/to/file>>

   The bot will intercept this and send the file through Telegram.
   Images (.jpg, .jpeg, .png, .webp) are sent as native Telegram photos.
   All other files (including .gif, .pdf, .md, etc.) are sent as documents.

   Rules:
   - Only send files under 50 MB (Telegram's limit). Warn the user if a file is too large.
   - Only send files that exist and are within the allowed directories listed above.
   - Always use absolute paths in the directive.
   - You can send multiple files by including multiple directives.
`;
}

export const SAFETY_PROMPT = buildSafetyPrompt(ALLOWED_PATHS);

// Dangerous command patterns to block
export const BLOCKED_PATTERNS = [
  "rm -rf /",
  "rm -rf ~",
  "rm -rf $HOME",
  "sudo rm",
  ":(){ :|:& };:", // Fork bomb
  "> /dev/sd",
  "mkfs.",
  "dd if=",
];

// Query timeout (3 minutes)
export const QUERY_TIMEOUT_MS = 180_000;

// ============== Voice Transcription ==============

const BASE_TRANSCRIPTION_PROMPT = `Transcribe this voice message accurately.
The speaker may use multiple languages (English, and possibly others).
Focus on accuracy for proper nouns, technical terms, and commands.`;

const TRANSCRIPTION_CONTEXT = process.env.TRANSCRIPTION_CONTEXT || "";

export const TRANSCRIPTION_PROMPT = TRANSCRIPTION_CONTEXT
  ? `${BASE_TRANSCRIPTION_PROMPT}\n\nAdditional context:\n${TRANSCRIPTION_CONTEXT}`
  : BASE_TRANSCRIPTION_PROMPT;

export const TRANSCRIPTION_AVAILABLE = !!OPENAI_API_KEY;

// ============== Thinking Keywords ==============

const thinkingKeywordsStr =
  process.env.THINKING_KEYWORDS || "think,think about";
const thinkingDeepKeywordsStr =
  process.env.THINKING_DEEP_KEYWORDS || "ultrathink,think hard,think deeply";

export const THINKING_KEYWORDS = thinkingKeywordsStr
  .split(",")
  .map((k) => k.trim().toLowerCase());
export const THINKING_DEEP_KEYWORDS = thinkingDeepKeywordsStr
  .split(",")
  .map((k) => k.trim().toLowerCase());

// ============== Media Group Settings ==============

export const MEDIA_GROUP_TIMEOUT = 1000; // ms to wait for more photos in a group

// ============== Telegram Message Limits ==============

export const TELEGRAM_MESSAGE_LIMIT = 4096; // Max characters per message
export const TELEGRAM_SAFE_LIMIT = 4000; // Safe limit with buffer for formatting
export const STREAMING_THROTTLE_MS = 500; // Throttle streaming updates
export const BUTTON_LABEL_MAX_LENGTH = 30; // Max chars for inline button labels

// ============== Audit Logging ==============

export const AUDIT_LOG_PATH =
  process.env.AUDIT_LOG_PATH || "/tmp/claude-telegram-audit.log";
export const AUDIT_LOG_JSON =
  (process.env.AUDIT_LOG_JSON || "false").toLowerCase() === "true";

// ============== Rate Limiting ==============

export const RATE_LIMIT_ENABLED =
  (process.env.RATE_LIMIT_ENABLED || "true").toLowerCase() === "true";
export const RATE_LIMIT_REQUESTS = parseInt(
  process.env.RATE_LIMIT_REQUESTS || "20",
  10,
);
export const RATE_LIMIT_WINDOW = parseInt(
  process.env.RATE_LIMIT_WINDOW || "60",
  10,
);

// ============== Web UI ==============

export const WEB_PORT = process.env.WEB_PORT
  ? parseInt(process.env.WEB_PORT, 10)
  : undefined;
export const WEB_TOKEN = process.env.WEB_TOKEN || "";
export const WEB_ENABLED =
  (process.env.WEB_ENABLED || "false").toLowerCase() === "true";

// ============== TTS ==============

export const TTS_RESPONSE_FORMAT =
  (process.env.TTS_RESPONSE_FORMAT as "opus" | "mp3" | undefined) || "opus";

// ============== Channel Relay ==============

export const RELAY_PORT_FILE_PREFIX = "/tmp/channel-relay-";
export const RELAY_CONNECT_TIMEOUT_MS = 3_000;
export const RELAY_RESPONSE_TIMEOUT_MS = 300_000; // 5 min — relay waits for Claude

// ============== File Paths ==============

export const SESSION_FILE = "/tmp/claude-telegram-session.json";
export const RESTART_FILE = "/tmp/claude-telegram-restart.json";
export const TEMP_DIR = "/tmp/telegram-bot";

// Temp paths that are always allowed for bot operations
export const TEMP_PATHS = ["/tmp/", "/private/tmp/", "/var/folders/"];

// Ensure temp directory exists
await mkdir(TEMP_DIR, { recursive: true });

// ============== Validation ==============

if (!TELEGRAM_TOKEN) {
  logError("startup: TELEGRAM_BOT_TOKEN required");
  process.exit(1);
}

if (ALLOWED_USERS.length === 0) {
  logError("startup: TELEGRAM_ALLOWED_USERS required");
  process.exit(1);
}
