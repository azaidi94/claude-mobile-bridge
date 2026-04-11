/** Extra keys required by `handlers/commands` when tests mock `../config`. */
export const DESKTOP_SPAWN_CONFIG_MOCK = {
  isDesktopClaudeSpawnSupported: () => true,
  DESKTOP_TERMINAL_APP: "Terminal",
  DESKTOP_CLAUDE_DEFAULT_ARGS:
    "--dangerously-skip-permissions --dangerously-load-development-channels server:channel-relay",
  DESKTOP_CLAUDE_COMMAND_TEMPLATE: "",
};
