# Claude Mobile Bridge

Telegram bot for controlling Claude Code sessions remotely.

## Commands

```bash
bun run dev          # Run bot with watch mode
bun run typecheck    # Typecheck
bun test             # Run tests
```

## Patterns

**Adding a command**: Create handler in `handlers/commands.ts`, register in `bot.ts` with `bot.command("name", handler)`

**Streaming**: All handlers use `createStatusCallback()` and `session.sendMessageStreaming()` for live updates.

## Configuration

Configure via `.env` (see `.env.example`). MCP servers defined in `mcp-config.ts` (copy from `mcp-config.example.ts`).

## Commit Style

Do not add "Generated with Claude Code" footers or "Co-Authored-By" trailers to commit messages.
