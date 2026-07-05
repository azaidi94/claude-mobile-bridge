# Channel Relay

[← README](../README.md)

The channel relay lets you message a running desktop Claude session from Telegram without disconnecting it. Claude sees your message as a channel notification and replies via the relay — both desktop and mobile stay connected.

**Setup:**

1. Register the relay as a global MCP server (replace the path with your clone location):

```bash
claude mcp add -s user channel-relay -- bun run ~/Dev/claude-mobile-bridge/src/mcp/channel-relay/server.ts
```

2. Start Claude with the relay channel. You need these flags **every time** you launch a session:

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:channel-relay
```

> **Development-channels prompt:** Claude Code will show a menu (“I am using this for local development” vs “Exit”). Choose **1** and press **Enter**. This is required by the CLI; Telegram/`/new` cannot automate it.

## Remote use (you are not at the Mac)

`/new` opens **Terminal on the machine running the bot**. If nobody can click through the dev-channels menu:

1. **Leave a relay-enabled desktop session running** before you go (`/list` → use that session from Telegram). No Terminal prompt until you restart Claude.
2. **Screen Sharing / VNC / Tailscale** to the Mac once to confirm the menu when you must spawn a new session.
3. **Auto-confirm (headless-friendly):** use the bundled expect wrapper and point `.env` at it (requires `/usr/bin/expect`, standard on macOS):

```bash
# Absolute path to this repo on the Mac that runs the bot
export DESKTOP_CLAUDE_COMMAND='/Users/you/claude-mobile-bridge/scripts/claude-relay-launch.sh {dir}'
# If `claude` is not on PATH in Terminal.app, set one of:
# export CLAUDE=/Users/you/.local/bin/claude
# export CLAUDE_CLI_PATH=/Users/you/.local/bin/claude
```

The script answers **1** when it sees the “local development” line, then keeps Claude running. If Anthropic changes the prompt text, update the script or fall back to options 1–2.

### Shell alias

Add a shell alias to avoid typing the launch flags each time:

```bash
alias cc='claude --dangerously-skip-permissions --dangerously-load-development-channels server:channel-relay'
```

`/new` runs `claude` with those flags in a new Terminal (or iTerm) window. Use `DESKTOP_CLAUDE_COMMAND` in `.env` if you prefer a custom shell line (see `.env.example`).

**How it works:** Each relay instance writes a port file to `/tmp/channel-relay-*.json`. The bot scans these to discover relay-enabled sessions and connects over TCP. When a relay is available, the bot routes messages through it. If no relay-enabled desktop session is found, use `/new` to spawn one or `/list` to pick an existing session.

`/status` shows relay connection state. `/list` shows a 📡 indicator on relay-enabled sessions.
