# Claude Mobile Bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.0.23+-black.svg)](https://bun.sh/)

Control Claude Code sessions from your phone via Telegram. Multi-session support for switching between projects.

## Features

- **Multi-session support** - Switch between Claude Code projects on the fly
- **Auto-discovery** - Detects running Claude Code sessions automatically
- **Streaming responses** with live updates
- **Channel relay** - Inject messages into running desktop sessions without disconnecting them
- **Live handoff** - Watch desktop Claude sessions in real-time, then take over with a message
- **Task queue** - Queue multiple tasks for sequential background execution
- **Plan mode** - Have Claude propose a plan before executing
- **Voice, photos & documents** - Voice transcribed via OpenAI, photos/PDFs/text files analyzed
- **Extended thinking** - "think" keyword for deeper reasoning, "ultrathink" for 50k tokens
- **Interrupt with `!`** - Prefix message to interrupt current query
- **MCP support** - Configure external tools in `mcp-config.ts`
- **Interactive buttons** - Claude can present options as tappable buttons

## Commands

| Category | Commands |
| --- | --- |
| Sessions | `/list`, `/switch`, `/new`, `/spawn`, `/kill` |
| Control | `/plan`, `/stop`, `/retry`, `/status`, `/model`, `/restart` |
| Live handoff | `/watch`, `/unwatch` |
| Task queue | `/queue`, `/skip` |
| Files | `/pwd`, `/cd`, `/ls` |

## Quick Start

**Prerequisites:** [Bun 1.0.23+](https://bun.sh/), [Claude Code CLI](https://claude.com/code), [Telegram Bot Token](https://t.me/botfather)

```bash
git clone https://github.com/azaidi94/claude-mobile-bridge.git
cd claude-mobile-bridge
bun install
cp .env.example .env              # Edit with your credentials
cp mcp-config.example.ts mcp-config.ts  # Optional: configure MCP tools for SDK sessions
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
claude --channels server:channel-relay --dangerously-load-development-channels server:channel-relay
```

> **Tip:** Add a shell alias to avoid typing this each time:
> ```bash
> alias cc='claude --channels server:channel-relay --dangerously-load-development-channels server:channel-relay'
> ```

**How it works:** Each relay instance writes a port file to `/tmp/channel-relay-*.json`. The bot scans these to discover relay-enabled sessions and connects over TCP. When a relay is available, the bot routes messages through it. When it's not (regular `claude` sessions), the bot falls back to the SDK path.

`/status` shows relay connection state. `/list` shows a 📡 indicator on relay-enabled sessions.

## Session Auto-Discovery

Start Claude Code normally and sessions appear in `/list` automatically:

```bash
claude                    # Current directory
claude --cwd ~/code/foo   # Specific directory
```

Or spawn a desktop session directly from Telegram (requires [cmux](https://cmux.dev)):

```
/spawn myproject          # Relative to CLAUDE_WORKING_DIR
/spawn /absolute/path     # Absolute path
```

> Set `CLAUDE_WORKING_DIR` in `.env` to use relative paths with `/spawn`.

## Development

```bash
bun run dev          # Run with file watching
bun run typecheck    # TypeScript type checking
bun test             # Run all tests
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
