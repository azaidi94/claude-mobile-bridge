# Claude Mobile Bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.0.23+-black.svg)](https://bun.sh/)

Control Claude Code sessions from your phone via Telegram. Each Claude Code session gets its own Telegram topic thread for organized multi-session control.

## Features

- **Multi-session support** - Switch between Claude Code projects on the fly
- **Auto-discovery** - Detects running Claude Code sessions automatically
- **Streaming responses** with live updates
- **Channel relay** - Inject messages into running desktop sessions without disconnecting them
- **Live handoff** - Watch desktop Claude sessions in real-time from Telegram
- **Voice, photos & documents** - Voice transcribed via OpenAI, photos/PDFs/text files analyzed
- **Extended thinking** - "think" keyword for deeper reasoning, "ultrathink" for 50k tokens
- **Interrupt with `!`** - Prefix message to interrupt current query
- **MCP support** - Configure external tools in `mcp-config.ts`
- **Interactive buttons** - Claude can present options as tappable buttons

## Commands

| Category | Commands                                           |
| -------- | -------------------------------------------------- |
| Sessions | `/list`, `/new`, `/sessions`, `/kill`              |
| Control  | `/stop`, `/retry`, `/status`, `/model`, `/restart` |
| Files    | `/pwd`, `/cd`, `/ls`                               |
| Quota    | `/usage`                                           |
| Scripts  | `/execute`                                         |
| Settings | `/settings`                                        |

## Quick Start

### BotFather Setup (Topics)

1. Open @BotFather Mini App
2. Select your bot
3. Enable "Topics in Private Chats"
4. Optional: disable "Allow users to create topics" (bot manages topics)

### Install

**Prerequisites:** [Bun 1.0.23+](https://bun.sh/), [Claude Code CLI](https://claude.com/code), [Telegram Bot Token](https://t.me/botfather)

```bash
git clone https://github.com/azaidi94/claude-mobile-bridge.git
cd claude-mobile-bridge
bun install
cp .env.example .env              # Edit with your credentials
cp mcp-config.example.ts mcp-config.ts  # Optional: configure MCP tools
bun run start
```

Required `.env` variables:

```bash
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_ALLOWED_USERS=123456789  # Your Telegram user ID (get from @userinfobot)
```

See `.env.example` for all options (working dir, allowed paths, voice transcription, rate limits, etc).

## Channel Relay

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

### Remote use (you are not at the Mac)

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

> **Tip:** Add a shell alias to avoid typing this each time:
>
> ```bash
> alias cc='claude --dangerously-skip-permissions --dangerously-load-development-channels server:channel-relay'
> ```
>
> `/new` runs `claude` with those flags in a new Terminal (or iTerm) window. Use `DESKTOP_CLAUDE_COMMAND` in `.env` if you prefer a custom shell line (see `.env.example`).

**How it works:** Each relay instance writes a port file to `/tmp/channel-relay-*.json`. The bot scans these to discover relay-enabled sessions and connects over TCP. When a relay is available, the bot routes messages through it. If no relay-enabled desktop session is found, use `/new` to spawn one or `/list` to pick an existing session.

`/status` shows relay connection state. `/list` shows a 📡 indicator on relay-enabled sessions.

## Session Auto-Discovery

Start Claude Code normally and sessions appear in `/list` automatically:

```bash
claude                    # Current directory
claude --cwd ~/code/foo   # Specific directory
```

Or spawn a relay-enabled desktop session from Telegram with `/new` (**macOS**):

```
/new                      # CLAUDE_WORKING_DIR
/new myproject            # Relative to CLAUDE_WORKING_DIR
/new /absolute/path       # Absolute path
```

> Set `CLAUDE_WORKING_DIR` in `.env` to use relative paths with `/new`.

`/new` opens a new window in **Terminal.app** by default. Pick a different
terminal via `DESKTOP_TERMINAL_APP` in `.env`:

| Value      | Launches                                                 |
| ---------- | -------------------------------------------------------- |
| `Terminal` | macOS Terminal.app (default)                             |
| `iTerm2`   | iTerm2 via AppleScript                                   |
| `Ghostty`  | Ghostty.app                                              |
| `cmux`     | cmux.app workspace — must have the `cmux` CLI on `$PATH` |

Resume an offline session (one with JSONL history but no live process) with `/sessions`. The bot lists recent project directories within `ALLOWED_PATHS`, shows the last message preview, and tapping Resume opens Terminal in that directory and starts `claude` with the channel-relay flags (same as `/new`).

## Shell Scripts (`/execute`)

`/execute` shows inline Start/Stop buttons for any shell scripts listed in `execute-commands.json` — handy for toggling a VPN, port-forward, or other long-running helper from your phone. Copy the example and edit:

```bash
cp execute-commands.example.json execute-commands.json
```

```json
[
  { "name": "VPN", "script": "/absolute/path/to/connect-vpn.sh" },
  { "name": "Tunnel", "script": "/absolute/path/to/tunnel.sh" }
]
```

Scripts run detached; Start/Stop liveness is tracked by PID. Override the config location with `EXECUTE_COMMANDS_FILE` in `.env`.

## Settings (`/settings`)

`/settings` opens a persistent settings panel with tap-to-edit fields:

| Field            | Effect                                                              |
| ---------------- | ------------------------------------------------------------------- |
| 🖥 Terminal      | Terminal used by `/new` and `/sessions → Resume`                    |
| 📁 Working dir   | Default project dir for `/new` (when no arg given)                  |
| 👁 Auto-watch    | Whether `/new` auto-attaches a watch after spawn                    |
| 🤖 Model         | Default model — shares state with `/model`                          |
| 📌 Topics        | Enable topic-per-session mode (`topicsEnabled`, default: true)      |
| 📌 Pinned status | Pin status messages in topics (`enablePinnedStatus`, default: true) |

Values live in `~/.claude-mobile-bridge/settings.json` and override the matching `.env` values. Tap **↺ Reset to default** on any sub-menu to drop the override and fall back to the env value. Auto-watch cycles `default → off → on → default` on each tap.

## Development

```bash
bun run dev          # Run with file watching
bun run typecheck    # TypeScript type checking
bun run test         # Run all tests (isolated per-file to avoid state leaks)
```

## Running as a Service (macOS)

```bash
cp scripts/launchagent/com.claude-telegram-ts.plist.template ~/Library/LaunchAgents/com.claude-telegram-ts.plist
# Edit plist with your paths
launchctl load ~/Library/LaunchAgents/com.claude-telegram-ts.plist
```

## Security

See [SECURITY.md](SECURITY.md). User allowlist, path validation, command safety checks, rate limiting, and audit logging.

## License

MIT
