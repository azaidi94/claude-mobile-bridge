# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Commands

```bash
bun install                        # Install all dependencies
bun run assistant                  # Run personal assistant bot
bun run coding                     # Run coding bot
bun run typecheck                  # Typecheck all packages

# Or directly in packages:
cd packages/assistant && bun run start
cd packages/coding && bun run start
```

## Architecture

Claude Mobile Bridge - A monorepo with two Telegram bots for controlling Claude Code.

### Packages

- **`packages/assistant/`** - Single-session personal assistant bot
- **`packages/coding/`** - Multi-session coding bot with session switching
- **`shared/`** - Common utilities (formatting, types)

### Message Flow

```
Telegram message → Handler → Auth check → Rate limit → Claude session → Streaming response → Audit log
```

### Assistant Bot (`packages/assistant/src/`)

Simplified single-session bot:
- **`index.ts`** - Entry point, registers handlers
- **`config.ts`** - Environment parsing, MCP loading
- **`session.ts`** - Simplified ClaudeSession (no multi-session)
- **`handlers/`** - Command and message handlers

### Coding Bot (`packages/coding/src/`)

Full multi-session bot:
- **`index.ts`** - Entry point with all session commands
- **`sessions/watcher.ts`** - Auto-discovers sessions via fs.watch + polling
- **`scripts/claudet`** - Simple CLI to start Claude Code

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

Each package has its own `.env`:
- `packages/assistant/.env`
- `packages/coding/.env`

Key variables:
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` (required)
- `CLAUDE_WORKING_DIR` - Working directory for Claude
- `ALLOWED_PATHS` - Directories Claude can access
- `OPENAI_API_KEY` - For voice transcription

MCP servers defined in `mcp-config.ts` in each package.

## Commit Style

Do not add "Generated with Claude Code" footers or "Co-Authored-By" trailers to commit messages.

## claudet CLI (Coding Bot)

Start Claude Code - sessions are auto-discovered by the bot:

```bash
cd packages/coding
./scripts/claudet              # Current dir
./scripts/claudet ~/code/foo   # Specific dir
```

Sessions appear automatically in `/list` within seconds.
