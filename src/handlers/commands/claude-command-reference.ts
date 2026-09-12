/**
 * Static reference text for `/claude` with no argument — the built-in Claude
 * Code slash commands, grouped the way the official commands reference does.
 * `/claude <name> [args]` types `/<name> [args]` into the terminal (see
 * inject.ts); this is just the discoverability list, not a live query — `/`
 * typed directly in the session is the only truly authoritative source
 * (availability varies by platform, plan, and environment).
 */

import { escapeHtml } from "../../formatting";

interface CommandEntry {
  name: string;
  purpose: string;
}

interface CommandGroup {
  title: string;
  commands: CommandEntry[];
}

const GROUPS: CommandGroup[] = [
  {
    title: "Session and context",
    commands: [
      { name: "/clear", purpose: "New conversation, empty context" },
      { name: "/compact", purpose: "Summarize to free context" },
      { name: "/autocompact", purpose: "Set auto-compaction threshold" },
      { name: "/context", purpose: "Visualize context usage" },
      { name: "/rewind", purpose: "Roll back to a checkpoint" },
      { name: "/branch", purpose: "Branch the conversation" },
      { name: "/fork", purpose: "Copy into a new background session" },
      { name: "/subtask", purpose: "Hand a side task to a subagent" },
      { name: "/background", purpose: "Detach to run as a background agent" },
      { name: "/resume", purpose: "Resume by ID/name, or open picker" },
      { name: "/rename", purpose: "Rename the session" },
      { name: "/recap", purpose: "One-line summary of the session" },
      { name: "/btw", purpose: "Side question, not added to history" },
      { name: "/export", purpose: "Export the conversation as text" },
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
      { name: "/model", purpose: "Switch model" },
      { name: "/effort", purpose: "Set reasoning effort" },
      { name: "/fast", purpose: "Toggle fast mode" },
      { name: "/advisor", purpose: "Enable/disable the advisor tool" },
    ],
  },
  {
    title: "Code work",
    commands: [
      { name: "/plan", purpose: "Enter plan mode" },
      { name: "/diff", purpose: "Interactive diff viewer" },
      { name: "/code-review", purpose: "Review diff/PR/branch/path" },
      { name: "/security-review", purpose: "Security review of branch diff" },
      { name: "/batch", purpose: "Decompose a codebase-wide change" },
      { name: "/debug", purpose: "Debug logging + troubleshooting" },
      { name: "/run", purpose: "Launch and drive the app" },
      {
        name: "/run-skill-generator",
        purpose: "Record a per-project launch skill",
      },
      { name: "/deep-research", purpose: "Fan-out web research report" },
      { name: "/dataviz", purpose: "Chart/dashboard design guidance" },
      {
        name: "/design-sync",
        purpose: "Upload design system to Claude Design",
      },
      { name: "/design-login", purpose: "Authorize design-system access" },
      { name: "/claude-api", purpose: "API / Managed Agents reference" },
      { name: "/autofix-pr", purpose: "Watch a PR, push fixes on CI failure" },
      { name: "/goal", purpose: "Set a cross-turn completion condition" },
      { name: "/loop", purpose: "Run a prompt repeatedly this session" },
      { name: "/schedule", purpose: "Manage cloud routines" },
    ],
  },
  {
    title: "Config and setup",
    commands: [
      { name: "/init", purpose: "Generate a starter CLAUDE.md" },
      { name: "/memory", purpose: "Edit CLAUDE.md / auto memory" },
      { name: "/config", purpose: "Settings interface" },
      { name: "/permissions", purpose: "Manage allow/ask/deny rules" },
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
      { name: "/add-dir", purpose: "Add a working directory" },
      { name: "/cd", purpose: "Move session to a new cwd" },
      { name: "/doctor", purpose: "Full setup checkup" },
      { name: "/import", purpose: "Import config from Codex/Gemini CLI" },
    ],
  },
  {
    title: "Extensions and integrations",
    commands: [
      { name: "/mcp", purpose: "Manage MCP servers and OAuth" },
      { name: "/plugin", purpose: "Plugin menu / subcommands" },
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
      { name: "/color", purpose: "Set prompt bar color" },
      { name: "/scroll-speed", purpose: "Adjust scroll speed (fullscreen)" },
      { name: "/usage", purpose: "Usage and limits breakdown" },
      { name: "/login", purpose: "Sign in" },
      { name: "/logout", purpose: "Sign out" },
      { name: "/privacy-settings", purpose: "View/update privacy settings" },
      { name: "/passes", purpose: "Share a free week of Claude Code" },
      { name: "/powerup", purpose: "Interactive feature lessons" },
      { name: "/insights", purpose: "HTML report on recent sessions" },
      { name: "/release-notes", purpose: "Changelog version picker" },
      { name: "/help", purpose: "Show help and available commands" },
      { name: "/bug", purpose: "Report a bug / send feedback" },
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
