# Claude Mobile Bridge

Telegram bot for controlling Claude Code sessions remotely.

## Commands

```bash
bun run dev          # Run bot with watch mode
bun run typecheck    # Typecheck
bun run test         # Run tests
```

**Always start `bun run dev` from inside the cmux session** (e.g. the terminal cmux
opened, or a Claude Code background shell running as a cmux workspace) — never
`nohup`/detached. The bot launches desktop sessions & ralph loops via `cmux
new-workspace`, which needs the live `CMUX_SOCKET_PATH` env; a detached launch
fails with "Could not open terminal — Failed to write to socket".

## Patterns

**Adding a command**: Create handler in `handlers/commands.ts`, register in `bot.ts` with `bot.command("name", handler)`

**Streaming**: All handlers use `createStatusCallback()` and `session.sendMessageStreaming()` for live updates.

**Topic routing**: Messages are routed by `message_thread_id`. Topic ↔ session mappings live in `src/topics/`. `topic-router.ts` resolves context, `topic-manager.ts` handles lifecycle, `topic-store.ts` handles persistence.

**Adding topic-aware commands**: Use `isSessionTopic(ctx)` to detect topic context, `showSessionPicker(ctx, action)` for General-context pickers. Pass `threadId` through to streaming/relay.

**Ralph loops**: `/ralph` runs `afk_tasks.sh` in a desktop terminal; `src/ralph/` tails its log and posts beats. The loop topic is NOT in topic-store (created raw via `createForumTopic`) — see `docs/ralph-loops.md`.

## Configuration

Configure via `.env` (see `.env.example`). MCP servers defined in `mcp-config.ts` (copy from `mcp-config.example.ts`).

## Logging

Use `src/logger.ts`: `info/warn/error/debug(msg, fields?)`. Put variable data in the structured `fields` object (`key=value`), not interpolated into `msg`, so lines stay greppable. Levels are gated by `LOG_LEVEL` (default `info`; `DEBUG=1` aliases `debug`).

**Levels**: `error` = user-visible action silently failed; `warn` = degraded-but-recovered / ambiguous / misconfig an operator should see; `info` = lifecycle milestone; `debug` = per-tick mechanics (hidden by default). Don't log no-op periodic ticks at info.

**Correlation fields**: on the message lifecycle (handler → streaming → relay), attach `opId`, `session`, `topic`, `chatId` (exact key names — see `CorrelationFields` in `logger.ts`) so one message is greppable end-to-end.

## Commit Style

Do not add "Generated with Claude Code" footers or "Co-Authored-By" trailers to commit messages.
