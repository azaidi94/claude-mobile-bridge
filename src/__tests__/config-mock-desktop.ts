/** Extra keys required by `handlers/commands` when tests mock `../config`. */
export const DESKTOP_SPAWN_CONFIG_MOCK = {
  isDesktopClaudeSpawnSupported: () => true,
  findClaudeCli: () => "/usr/local/bin/claude",
  parseTerminalApp: (
    raw: string,
  ): "terminal" | "iterm2" | "ghostty" | "cmux" => {
    const v = raw.trim().toLowerCase();
    if (v === "iterm" || v === "iterm2") return "iterm2";
    if (v === "ghostty") return "ghostty";
    if (v === "cmux") return "cmux";
    return "terminal";
  },
  DESKTOP_TERMINAL_APP: "terminal" as const,
  DESKTOP_CLAUDE_DEFAULT_ARGS:
    "--dangerously-skip-permissions --dangerously-load-development-channels server:channel-relay",
  DESKTOP_CLAUDE_COMMAND_TEMPLATE: "",
  RALPH_SCRIPT: "",
  RALPH_PROMPT: "",
  RALPH_TIMEOUT: "",
  WATCHDOG_IDLE_MS: 600_000,
  WATCHDOG_AUTO_CONTINUE: false,
  WATCHDOG_TICK_MS: 30_000,
};
