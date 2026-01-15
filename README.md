# Claude Mobile Bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.0.23+-black.svg)](https://bun.sh/)

Control Claude Code sessions from your phone via Telegram. Two bots for different use cases:

![Demo](assets/demo.gif)

## Bots

### Personal Assistant Bot (`packages/assistant/`)

A single-session 24/7 personal assistant. Point it at a folder with your `CLAUDE.md`, notes, and MCPs, and interact with Claude from anywhere.

**Commands:** `/start`, `/new`, `/stop`, `/status`, `/retry`, `/resume`, `/restart`

See [Personal Assistant Guide](docs/personal-assistant-guide.md) for setup ideas.

### Coding Bot (`packages/coding/`)

Multi-session support for switching between Claude Code projects. Control desktop sessions or create new ones on the fly.

**Session Commands:** `/list`, `/switch`, `/discover`, `/new`, `/kill`, `/killall`
**Control Commands:** `/start`, `/stop`, `/status`, `/retry`, `/resume`, `/restart`

Includes `claudet` CLI for starting sessions pre-registered for Telegram control.

## Features

- **Streaming responses** with live updates
- **Voice messages** (transcribed via OpenAI Whisper)
- **Photos & documents** (PDFs, images, text files)
- **Extended thinking** - use "think" keyword for deeper reasoning
- **Interrupt with `!`** - prefix message to interrupt current query
- **MCP support** - configure in `mcp-config.ts`
- **Interactive buttons** - Claude can present options as tappable buttons

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
# For Personal Assistant Bot
cp packages/assistant/.env.example packages/assistant/.env
# Edit with your credentials

# For Coding Bot
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
# Personal Assistant Bot
cd packages/assistant && bun run start

# Coding Bot
cd packages/coding && bun run start
```

## Project Structure

```
claude-mobile-bridge/
├── packages/
│   ├── assistant/     # Personal assistant bot (single session)
│   │   ├── src/
│   │   ├── .env.example
│   │   └── mcp-config.ts
│   │
│   └── coding/        # Coding bot (multi-session)
│       ├── src/
│       ├── scripts/claudet
│       ├── .env.example
│       └── mcp-config.ts
│
├── shared/            # Common utilities
├── docs/
│   ├── personal-assistant-guide.md
│   └── SECURITY.md
└── package.json       # Workspace root
```

## claudet CLI (Coding Bot)

Start Claude Code sessions that auto-register for Telegram control:

```bash
cd packages/coding
./scripts/claudet                    # Current dir, auto name
./scripts/claudet myproject          # Current dir, named "myproject"
./scripts/claudet myproject ~/code   # ~/code dir, named "myproject"
```

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

**For Assistant Bot:**
```
start - Show status
new - Start fresh session
stop - Stop current query
status - Check bot status
retry - Retry last message
resume - Resume last session
restart - Restart bot
```

**For Coding Bot:**
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
