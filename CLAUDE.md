# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Commands

```bash
bun install          # Install dependencies
bun run start        # Run bot
bun run dev          # Run bot with watch mode
bun run typecheck    # Typecheck
bun test             # Run tests
```

## Architecture

Claude Mobile Bridge - A Telegram bot for controlling Claude Code sessions remotely.

### Structure

- **`src/`** - All source code
  - **`index.ts`** - Entry point
  - **`bot.ts`** - Bot factory
  - **`handlers/`** - Command and message handlers
  - **`sessions/`** - Session management and watcher
  - **`formatting.ts`** - Markdown→HTML conversion
  - **`types.ts`** - TypeScript types
  - **`__tests__/`** - Tests

### Message Flow

```
Telegram message → Handler → Auth check → Rate limit → Claude session → Streaming response → Audit log
```

### Security Layers

1. User allowlist (`TELEGRAM_ALLOWED_USERS`)
2. Rate limiting (token bucket)
3. Path validation (`ALLOWED_PATHS`)
4. Command safety (blocked patterns)
5. System prompt constraints
6. Audit logging

## Patterns

**Adding a command**: Create handler in `handlers/commands.ts`, register in `bot.ts` with `bot.command("name", handler)`

**Streaming pattern**: All handlers use `createStatusCallback()` and `session.sendMessageStreaming()` for live updates.

## Configuration

Configure via `.env` (see `.env.example`):

Key variables:

- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` (required)
- `CLAUDE_WORKING_DIR` - Working directory for Claude
- `ALLOWED_PATHS` - Directories Claude can access
- `OPENAI_API_KEY` - For voice transcription

MCP servers defined in `mcp-config.ts` (copy from `mcp-config.example.ts`).

## Commit Style

Do not add "Generated with Claude Code" footers or "Co-Authored-By" trailers to commit messages.

## Session Auto-Discovery

The bot automatically discovers running Claude Code sessions. Just start Claude Code normally:

```bash
claude                    # Current directory
claude --cwd ~/code/foo   # Specific directory
```

Sessions appear automatically in `/list` within seconds.
