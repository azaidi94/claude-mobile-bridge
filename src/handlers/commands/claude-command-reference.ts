/**
 * Static reference text for `/claude` with no argument — the built-in Claude
 * Code slash commands, grouped the way the official commands reference does.
 * `/claude <name> [args]` types `/<name> [args]` into the terminal (see
 * inject.ts); this is just the discoverability list, not a live query — `/`
 * typed directly in the session is the only truly authoritative source
 * (availability varies by platform, plan, and environment).
 */

import { escapeHtml } from "../../formatting";

/**
 * How a command takes its argument when tapped in the /claude menu:
 *   - "none"     (default) send `/name` as is
 *   - "optional" offer "Send as is" or "Enter text…"
 *   - "required" ask for the text first, then send `/name <text>`
 * `options` lists fixed choices instead (tap → `/name <option>`).
 */
export type CommandArg = "none" | "optional" | "required";

export interface CommandEntry {
  name: string;
  purpose: string;
  arg?: CommandArg;
  /** Shown when asking for text, e.g. "your question". */
  argHint?: string;
  /** Fixed choices offered as a second-level menu (tap → `/name <option>`). */
  options?: string[];
  /** Not offered in the /claude button menu (still typeable as /claude <name>). */
  hidden?: boolean;
}

export interface CommandGroup {
  title: string;
  commands: CommandEntry[];
}

const GROUPS: CommandGroup[] = [
  {
    title: "Session and context",
    commands: [
      { name: "/clear", purpose: "New conversation, empty context" },
      { name: "/compact", purpose: "Summarize to free context" },
      {
        name: "/autocompact",
        purpose: "Set auto-compaction threshold",
        arg: "required",
        argHint: "a context percentage, e.g. 70",
      },
      { name: "/context", purpose: "Visualize context usage" },
      { name: "/rewind", purpose: "Roll back to a checkpoint" },
      {
        name: "/branch",
        purpose:
          "Branch the conversation in place (from the phone prefer /new --branch)",
      },
      {
        name: "/fork",
        purpose:
          "Copy into a new background session (in-process; from the phone use /new --branch)",
        hidden: true,
      },
      {
        name: "/subtask",
        purpose: "Hand a side task to a subagent",
        arg: "required",
        argHint: "what the subagent should do",
      },
      { name: "/background", purpose: "Detach to run as a background agent" },
      {
        name: "/resume",
        purpose: "Resume by ID/name, or open picker",
        arg: "optional",
        argHint: "a session id or name (empty = picker)",
      },
      {
        name: "/rename",
        purpose: "Rename the session",
        arg: "required",
        argHint: "the new session name",
      },
      { name: "/recap", purpose: "One-line summary of the session" },
      {
        name: "/btw",
        purpose: "Side question, not added to history",
        arg: "required",
        argHint: "your side question",
      },
      {
        name: "/export",
        purpose: "Export the conversation as text",
        arg: "optional",
        argHint: "a file path (empty = clipboard)",
      },
      { name: "/copy", purpose: "Copy the last response to clipboard" },
      {
        name: "/exit",
        purpose: "Exit the CLI — blocked via /claude, use /kill",
      },
    ],
  },
  {
    title: "Model and reasoning",
    commands: [
      {
        name: "/model",
        purpose: "Switch model",
        options: ["opus", "sonnet", "haiku"],
      },
      {
        name: "/effort",
        purpose: "Set reasoning effort",
        options: ["low", "medium", "high", "max"],
      },
      { name: "/fast", purpose: "Toggle fast mode" },
      { name: "/advisor", purpose: "Enable/disable the advisor tool" },
    ],
  },
  {
    title: "Code work",
    commands: [
      { name: "/plan", purpose: "Enter plan mode" },
      { name: "/diff", purpose: "Interactive diff viewer" },
      {
        name: "/code-review",
        purpose: "Review diff/PR/branch/path",
        arg: "optional",
        argHint: "a PR number, branch or path (empty = current diff)",
      },
      { name: "/security-review", purpose: "Security review of branch diff" },
      {
        name: "/batch",
        purpose: "Decompose a codebase-wide change",
        arg: "required",
        argHint: "the change to make across the codebase",
      },
      { name: "/debug", purpose: "Debug logging + troubleshooting" },
      { name: "/run", purpose: "Launch and drive the app" },
      {
        name: "/run-skill-generator",
        purpose: "Record a per-project launch skill",
        arg: "optional",
        argHint: "a skill name",
      },
      {
        name: "/deep-research",
        purpose: "Fan-out web research report",
        arg: "required",
        argHint: "the research question",
      },
      { name: "/dataviz", purpose: "Chart/dashboard design guidance" },
      {
        name: "/design-sync",
        purpose: "Upload design system to Claude Design",
      },
      { name: "/design-login", purpose: "Authorize design-system access" },
      { name: "/claude-api", purpose: "API / Managed Agents reference" },
      {
        name: "/autofix-pr",
        purpose: "Watch a PR, push fixes on CI failure",
        arg: "required",
        argHint: "the PR number or URL",
      },
      {
        name: "/goal",
        purpose: "Set a cross-turn completion condition",
        arg: "required",
        argHint: "the completion condition",
      },
      {
        name: "/loop",
        purpose: "Run a prompt repeatedly this session",
        arg: "required",
        argHint: 'the prompt to repeat (e.g. "5m /foo")',
      },
      {
        name: "/schedule",
        purpose: "Manage cloud routines",
        arg: "optional",
        argHint: "a subcommand (empty = list)",
      },
    ],
  },
  {
    title: "Config and setup",
    commands: [
      { name: "/init", purpose: "Generate a starter CLAUDE.md" },
      {
        name: "/memory",
        purpose: "Edit CLAUDE.md / auto memory",
        arg: "optional",
        argHint: '"auto" or empty',
      },
      { name: "/config", purpose: "Settings interface" },
      {
        name: "/permissions",
        purpose: "Manage allow/ask/deny rules",
        options: ["default", "acceptEdits", "plan", "bypassPermissions"],
      },
      {
        name: "/auto-mode-setup",
        purpose: "Draft autoMode.environment entries",
      },
      {
        name: "/fewer-permission-prompts",
        purpose: "Build allowlist from transcripts",
      },
      { name: "/sandbox", purpose: "Toggle sandbox mode" },
      { name: "/hooks", purpose: "View hook configurations" },
      { name: "/keybindings", purpose: "Open keyboard shortcuts file" },
      {
        name: "/add-dir",
        purpose: "Add a working directory",
        arg: "required",
        argHint: "an absolute directory path",
      },
      {
        name: "/cd",
        purpose: "Move session to a new cwd",
        arg: "required",
        argHint: "an absolute directory path",
      },
      { name: "/doctor", purpose: "Full setup checkup" },
      { name: "/import", purpose: "Import config from Codex/Gemini CLI" },
    ],
  },
  {
    title: "Extensions and integrations",
    commands: [
      {
        name: "/mcp",
        purpose: "Manage MCP servers and OAuth",
        arg: "optional",
        argHint: "a subcommand (empty = menu)",
      },
      {
        name: "/plugin",
        purpose: "Plugin menu / subcommands",
        arg: "optional",
        argHint: "a subcommand (empty = menu)",
      },
      { name: "/reload-plugins", purpose: "Apply pending plugin changes" },
      { name: "/reload-skills", purpose: "Re-scan skill/command directories" },
      { name: "/agents", purpose: "Subagent management pointer" },
      { name: "/chrome", purpose: "Configure Claude in Chrome" },
      { name: "/ide", purpose: "Manage IDE integrations" },
      { name: "/install-github-app", purpose: "Install Claude GitHub App" },
      { name: "/install-slack-app", purpose: "Install Claude Slack app" },
      { name: "/artifacts", purpose: "List artifacts you own/shared" },
    ],
  },
  {
    title: "Multi-device and multi-session",
    commands: [
      { name: "/list-agents", purpose: "List subagents/teammates/sessions" },
      {
        name: "/remote-control",
        purpose: "Enable Remote Control from claude.ai",
      },
      {
        name: "/remote-env",
        purpose: "Choose default cloud-agent environment",
      },
      { name: "/desktop", purpose: "Continue in the Desktop app" },
      { name: "/mobile", purpose: "QR code for the mobile app" },
    ],
  },
  {
    title: "Display and account",
    commands: [
      { name: "/focus", purpose: "Toggle focus view" },
      {
        name: "/color",
        purpose: "Set prompt bar color",
        arg: "required",
        argHint: "a color name or hex",
      },
      {
        name: "/scroll-speed",
        purpose: "Adjust scroll speed (fullscreen)",
        arg: "required",
        argHint: "a speed, e.g. 2",
      },
      { name: "/usage", purpose: "Usage and limits breakdown" },
      { name: "/login", purpose: "Sign in" },
      { name: "/logout", purpose: "Sign out" },
      { name: "/privacy-settings", purpose: "View/update privacy settings" },
      { name: "/passes", purpose: "Share a free week of Claude Code" },
      { name: "/powerup", purpose: "Interactive feature lessons" },
      { name: "/insights", purpose: "HTML report on recent sessions" },
      { name: "/release-notes", purpose: "Changelog version picker" },
      { name: "/help", purpose: "Show help and available commands" },
      {
        name: "/bug",
        purpose: "Report a bug / send feedback",
        arg: "required",
        argHint: "what went wrong",
      },
      { name: "/heapdump", purpose: "Heap snapshot (hidden, type in full)" },
    ],
  },
];

// Referenced in the changelog/skills docs rather than the reference table —
// not verified against the live command list, hence kept separate and marked.
const UNVERIFIED_TAIL = [
  "/simplify",
  "/verify",
  "/skills",
  "/tui",
  "/teleport",
  "/status",
  "/tasks",
  "/workflows",
  "/ultrareview",
  "/usage-credits",
  "/update",
  "/commit-push-pr",
  "/theme",
  "/terminal-setup",
  "/voice",
  "/design",
  "/radio",
  "/team-onboarding",
  "/statusline",
];

function render(): string {
  const sections = GROUPS.map((group) => {
    const rows = group.commands
      .map(
        (c) => `<code>${escapeHtml(c.name)}</code> — ${escapeHtml(c.purpose)}`,
      )
      .join("\n");
    return `<b>${escapeHtml(group.title)}</b>\n${rows}`;
  }).join("\n\n");

  const tail = UNVERIFIED_TAIL.map((c) => `<code>${escapeHtml(c)}</code>`).join(
    ", ",
  );

  return (
    `<b>Claude Code slash commands</b> — usable via <code>/claude &lt;name&gt; [args]</code>\n\n` +
    `${sections}\n\n` +
    `<b>Unverified (from changelog/skills docs, not the reference table)</b>\n${tail}\n\n` +
    `<i>Typing / in a live session is the only authoritative list — availability varies by platform, plan, and environment.</i>`
  );
}

export const CLAUDE_COMMAND_REFERENCE = render();

/** Structured form of the reference, for the /claude button menu. */
export const CLAUDE_COMMANDS: readonly CommandGroup[] = GROUPS;
