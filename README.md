# Claude Mobile Bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.0.23+-black.svg)](https://bun.sh/)

Control Claude Code sessions from your phone via Telegram. Multi-session support for switching between projects.

![Demo](assets/demo.gif)

## Features

- **Multi-session support** - Switch between Claude Code projects on the fly
- **Auto-discovery** - Detects running Claude Code sessions automatically
- **Streaming responses** with live updates
- **Voice messages** (transcribed via OpenAI Whisper)
- **Photos & documents** (PDFs, images, text files)
- **Extended thinking** - use "think" keyword for deeper reasoning
- **Interrupt with `!`** - prefix message to interrupt current query
- **MCP support** - configure in `mcp-config.ts`
- **Interactive buttons** - Claude can present options as tappable buttons

## Commands

**Session Commands:** `/list`, `/switch`, `/discover`, `/new`, `/kill`, `/killall`
**Control Commands:** `/start`, `/stop`, `/status`, `/retry`, `/resume`, `/restart`

## Quick Start

### Prerequisites

- **Bun 1.0.23+** - [Install Bun](https://bun.sh/) (run `bun upgrade` if older)
- **Claude Code CLI** - [Install Claude Code](https://claude.com/code)
- **Telegram Bot Token** - Create via [@BotFather](https://t.me/botfather)
- **OpenAI API Key** (optional) - For voice message transcription

### Install

```bash
git clone https://github.com/azaidi94/claude-mobile-bridge.git
cd claude-mobile-bridge
bun install
```

### Configure

```bash
cp packages/coding/.env.example packages/coding/.env
# Edit with your credentials
```

Key `.env` variables:

```bash
# Required
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_ALLOWED_USERS=123456789  # Your Telegram user ID

# Recommended
CLAUDE_WORKING_DIR=/path/to/your/folder
OPENAI_API_KEY=sk-...  # For voice messages
```

Find your Telegram user ID by messaging [@userinfobot](https://t.me/userinfobot).

### Run

```bash
cd packages/coding && bun run start
```

Or from the root:

```bash
bun run coding
```

## Project Structure

```
claude-mobile-bridge/
├── packages/
│   └── coding/        # Multi-session coding bot
│       ├── src/
│       ├── scripts/claudet
│       ├── .env.example
│       └── mcp-config.ts
│
├── shared/            # Common utilities
├── docs/
│   └── SECURITY.md
└── package.json       # Workspace root
```

## claudet CLI

Start Claude Code sessions that auto-register for Telegram control:

```bash
cd packages/coding
./scripts/claudet                    # Current dir, auto name
./scripts/claudet myproject          # Current dir, named "myproject"
./scripts/claudet myproject ~/code   # ~/code dir, named "myproject"
```

Sessions appear automatically in `/list` within seconds.

## Running as a Service (macOS)

```bash
cp launchagent/com.claude-telegram-ts.plist.template ~/Library/LaunchAgents/com.claude-telegram-ts.plist
# Edit plist with your paths
launchctl load ~/Library/LaunchAgents/com.claude-telegram-ts.plist
```

**Logs:**
```bash
tail -f /tmp/claude-telegram-bot-ts.log
```

## BotFather Commands

Send `/setcommands` to [@BotFather](https://t.me/botfather):

```
start - Show status
list - Show all sessions
switch - Switch to session
discover - Find desktop sessions
new - Create new session
kill - Kill active session
killall - Kill all sessions
stop - Stop current query
status - Check bot status
retry - Retry last message
restart - Restart bot
```

## Security

See [SECURITY.md](docs/SECURITY.md) for details. Multiple layers protect against misuse:

1. **User allowlist** - Only your Telegram IDs can use the bot
2. **Path validation** - File access restricted to `ALLOWED_PATHS`
3. **Command safety** - Destructive patterns blocked
4. **Rate limiting** - Configurable token bucket
5. **Audit logging** - All interactions logged

## License

MIT
