# Claude Mobile Bridge

Telegram bot for controlling Claude Code sessions remotely.

## Commands

```bash
bun run dev          # Run bot with watch mode
bun run typecheck    # Typecheck
bun run test         # Run tests
```

## Patterns

**Adding a command**: Create handler in `handlers/commands.ts`, register in `bot.ts` with `bot.command("name", handler)`

**Streaming**: All handlers use `createStatusCallback()` and `session.sendMessageStreaming()` for live updates.

**Topic routing**: Messages are routed by `message_thread_id`. Topic ↔ session mappings live in `src/topics/`. `topic-router.ts` resolves context, `topic-manager.ts` handles lifecycle, `topic-store.ts` handles persistence.

**Adding topic-aware commands**: Use `isSessionTopic(ctx)` to detect topic context, `showSessionPicker(ctx, action)` for General-context pickers. Pass `threadId` through to streaming/relay.

## Configuration

Configure via `.env` (see `.env.example`). MCP servers defined in `mcp-config.ts` (copy from `mcp-config.example.ts`).

## Commit Style

Do not add "Generated with Claude Code" footers or "Co-Authored-By" trailers to commit messages.
