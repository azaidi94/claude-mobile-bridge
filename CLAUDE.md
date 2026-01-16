# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Commands

```bash
bun install                        # Install all dependencies
bun run coding                     # Run coding bot
bun run typecheck                  # Typecheck all packages

# Or directly:
cd packages/coding && bun run start
```

## Architecture

Claude Mobile Bridge - A Telegram bot for controlling Claude Code sessions remotely.

### Packages

- **`packages/coding/`** - Multi-session coding bot with session switching
- **`shared/`** - Common utilities (formatting, types)

### Message Flow

```
Telegram message → Handler → Auth check → Rate limit → Claude session → Streaming response → Audit log
```

### Coding Bot (`packages/coding/src/`)

Full multi-session bot:
- **`index.ts`** - Entry point with all session commands
- **`sessions/watcher.ts`** - Auto-discovers running Claude Code sessions via fs.watch + polling

### Shared (`shared/`)

- **`formatting.ts`** - Markdown→HTML conversion, tool status emoji
- **`types.ts`** - Common TypeScript types

### Security Layers

1. User allowlist (`TELEGRAM_ALLOWED_USERS`)
2. Rate limiting (token bucket)
3. Path validation (`ALLOWED_PATHS`)
4. Command safety (blocked patterns)
5. System prompt constraints
6. Audit logging

## Patterns

**Adding a command**: Create handler in `commands.ts`, register in `index.ts` with `bot.command("name", handler)`

**Streaming pattern**: All handlers use `createStatusCallback()` and `session.sendMessageStreaming()` for live updates.

**Type checking**: Run `bun run typecheck` to check all packages.

## Configuration

Configure via `packages/coding/.env`:

Key variables:
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` (required)
- `CLAUDE_WORKING_DIR` - Working directory for Claude
- `ALLOWED_PATHS` - Directories Claude can access
- `OPENAI_API_KEY` - For voice transcription

MCP servers defined in `mcp-config.ts`.

## Commit Style

Do not add "Generated with Claude Code" footers or "Co-Authored-By" trailers to commit messages.

## Session Auto-Discovery

The bot automatically discovers running Claude Code sessions. Just start Claude Code normally:

```bash
claude                    # Current directory
claude --cwd ~/code/foo   # Specific directory
```

Sessions appear automatically in `/list` within seconds.
