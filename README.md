# Claude Mobile Bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.0.23+-black.svg)](https://bun.sh/)

Control Claude Code sessions from your phone via Telegram. Multi-session support for switching between projects.

## Features

- **Multi-session support** - Switch between Claude Code projects on the fly
- **Auto-discovery** - Detects running Claude Code sessions automatically
- **Streaming responses** with live updates
- **Plan mode** - Use `/plan` to have Claude propose a plan before executing
- **Voice messages** (transcribed via OpenAI Whisper)
- **Photos & documents** (PDFs, images, text files)
- **Extended thinking** - use "think" keyword for deeper reasoning
- **Interrupt with `!`** - prefix message to interrupt current query
- **MCP support** - configure in `mcp-config.ts`
- **Interactive buttons** - Claude can present options as tappable buttons

## Commands

**Session Commands:** `/list`, `/switch`, `/new`
**Control Commands:** `/start`, `/help`, `/plan`, `/stop`, `/status`, `/retry`, `/restart`

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
cp .env.example .env
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
bun run start
```

Or with file watching:

```bash
bun run dev
```

## Architecture

```
┌──────────────┐     ┌─────────────┐     ┌────────────────┐
│   Telegram   │◄───►│  Bot Server │◄───►│  Claude Code   │
│   (Phone)    │     │   (Bun)     │     │   Sessions     │
└──────────────┘     └─────────────┘     └────────────────┘
                            │
                            ▼
                     ┌─────────────┐
                     │   Security  │
                     │   Layers    │
                     └─────────────┘
```

### Message Flow

```
Telegram message → Handler → Auth check → Rate limit → Claude session → Streaming response → Audit log
```

### Project Structure

```
claude-mobile-bridge/
├── src/
│   ├── index.ts           # Entry point
│   ├── bot.ts             # Bot factory and middleware
│   ├── config.ts          # Environment configuration
│   ├── session.ts         # Claude Code session wrapper
│   ├── formatting.ts      # Markdown→HTML conversion
│   ├── security.ts        # Auth and safety checks
│   ├── handlers/
│   │   ├── commands.ts    # /start, /list, /switch, etc.
│   │   ├── text.ts        # Text message handler
│   │   ├── voice.ts       # Voice message handler
│   │   ├── photo.ts       # Photo handler
│   │   ├── document.ts    # Document handler
│   │   ├── streaming.ts   # Response streaming
│   │   └── callback.ts    # Button callback handler
│   ├── sessions/
│   │   ├── index.ts       # SessionManager
│   │   ├── watcher.ts     # Auto-discovery watcher
│   │   └── types.ts       # Session types
│   └── __tests__/         # Unit tests
├── mcp-config.ts          # MCP server configuration
├── .env.example           # Environment template
└── package.json
```

## Development

### Setup

```bash
git clone https://github.com/azaidi94/claude-mobile-bridge.git
cd claude-mobile-bridge
bun install
cp .env.example .env
# Edit .env with test credentials
```

### Commands

```bash
bun run start        # Run bot
bun run dev          # Run with file watching
bun run typecheck    # TypeScript type checking
bun test             # Run all tests
```

### Running Tests

Tests use Bun's built-in test runner with mocks for external dependencies.

```bash
# Run all tests
bun test

# Run specific test file
bun test src/__tests__/session-manager.test.ts

# Run with watch mode
bun test --watch
```

### Test Structure

```
src/__tests__/
├── smoke.test.ts           # Bot lifecycle smoke tests
├── session-manager.test.ts # Session discovery and tracking
├── message-router.test.ts  # Message routing logic
├── commands.test.ts        # Telegram command handlers
├── streaming.test.ts       # Response streaming
├── plan-mode.test.ts       # Plan mode functionality
└── setup.test.ts           # Test setup utilities

src/__mocks__/
└── grammy.ts               # Grammy (Telegram) mocks
```

### Mocking Approach

Tests mock external dependencies:

- **Grammy (Telegram)** - Mocked `Bot`, `Context`, `InlineKeyboard` classes
- **Claude SDK** - Mocked session creation and message streaming
- **File system** - Mocked for session discovery tests
- **Config** - Mocked environment variables per test

Example mock pattern:

```typescript
import { mock, spyOn } from "bun:test";

// Mock module before importing
mock.module("grammy", () => ({
  Bot: MockBot,
  Context: MockContext,
}));

// Spy on specific methods
const sendSpy = spyOn(ctx, "reply");
```

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/botfather) |
| `TELEGRAM_ALLOWED_USERS` | Comma-separated Telegram user IDs |

### Recommended

| Variable | Description |
|----------|-------------|
| `CLAUDE_WORKING_DIR` | Working directory for Claude (loads CLAUDE.md, skills) |
| `OPENAI_API_KEY` | OpenAI API key for voice transcription |

### Security

| Variable | Default | Description |
|----------|---------|-------------|
| `ALLOWED_PATHS` | Working dir + ~/Documents, ~/Downloads, ~/Desktop, ~/.claude | Paths Claude can access |
| `RATE_LIMIT_ENABLED` | `true` | Enable rate limiting |
| `RATE_LIMIT_REQUESTS` | `20` | Requests per window |
| `RATE_LIMIT_WINDOW` | `60` | Window in seconds |

### Claude Authentication

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API key (alternative to CLI auth, billed per token) |
| `CLAUDE_CLI_PATH` | Path to Claude CLI (auto-detected) |

### Extended Thinking

| Variable | Default | Description |
|----------|---------|-------------|
| `THINKING_KEYWORDS` | `think,pensa,ragiona` | Trigger extended thinking |
| `THINKING_DEEP_KEYWORDS` | `ultrathink,think hard,pensa bene` | Trigger deep thinking (50k tokens) |

### Voice Transcription

| Variable | Description |
|----------|-------------|
| `TRANSCRIPTION_CONTEXT` | Context for transcription (names, technical terms) |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `AUDIT_LOG_PATH` | `/tmp/claude-telegram-audit.log` | Audit log location |
| `AUDIT_LOG_JSON` | `false` | Output JSON format |

## Session Auto-Discovery

The bot automatically discovers running Claude Code sessions. Just start Claude Code normally:

```bash
claude                    # Current directory
claude --cwd ~/code/foo   # Specific directory
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
start - Welcome message
help - Show all commands
list - List sessions
switch - Switch session
new - New session
plan - Start plan mode
status - Session status
stop - Stop current query
retry - Retry last message
restart - Restart bot
```

## Troubleshooting

### Bot doesn't respond

1. Check `TELEGRAM_ALLOWED_USERS` includes your user ID
2. Verify bot token is correct: `curl https://api.telegram.org/bot<TOKEN>/getMe`
3. Check logs for errors: `bun run dev` shows verbose output

### Voice messages don't work

1. Ensure `OPENAI_API_KEY` is set and valid
2. Check rate limits on OpenAI account
3. Verify audio format is supported (most Telegram voice formats work)

### Sessions not discovered

1. Ensure Claude Code is running with `--resume`
2. Check `~/.claude/ide/` for session files
3. Verify permissions on session directory

### Rate limiting

If you hit rate limits:
1. Adjust `RATE_LIMIT_REQUESTS` and `RATE_LIMIT_WINDOW`
2. Or set `RATE_LIMIT_ENABLED=false` (not recommended for production)

### TypeScript errors

```bash
bun run typecheck
```

Common fixes:
- Run `bun install` to ensure all types are installed
- Check for missing `@types/*` packages

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. **Write tests** for new functionality
4. Ensure all tests pass: `bun test`
5. Ensure types check: `bun run typecheck`
6. Commit with conventional commits: `feat:`, `fix:`, `refactor:`
7. Open a pull request

### Test Requirements

- All new features must have corresponding tests
- Test coverage should remain above 80%
- Tests must pass before PR merge

## Security

See [SECURITY.md](docs/SECURITY.md) for details. Multiple layers protect against misuse:

1. **User allowlist** - Only your Telegram IDs can use the bot
2. **Path validation** - File access restricted to `ALLOWED_PATHS`
3. **Command safety** - Destructive patterns blocked
4. **Rate limiting** - Configurable token bucket
5. **Audit logging** - All interactions logged

## License

MIT
