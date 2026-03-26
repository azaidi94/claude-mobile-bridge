# Contributing

## Prerequisites

- [Bun 1.0.23+](https://bun.sh/)
- [Claude Code CLI](https://claude.com/code)
- A Telegram bot token from [@BotFather](https://t.me/botfather)

## Setup

```bash
git clone https://github.com/azaidi94/claude-mobile-bridge.git
cd claude-mobile-bridge
bun install
cp .env.example .env  # Edit with your credentials
```

## Development

```bash
bun run dev          # Run with file watching
bun run typecheck    # TypeScript type checking
bun test             # Run all tests
```

## Code Style

Prettier is enforced via pre-commit hook (husky + lint-staged). No manual formatting needed.

## Pull Requests

1. Fork the repo and create a branch
2. Make your changes
3. Ensure `bun run typecheck` and `bun test` pass
4. Open a PR with a clear description

## Adding a Command

Create the handler in `src/handlers/commands.ts`, export it from `src/handlers/index.ts`, and register it in `src/bot.ts` with `bot.command("name", handler)`.

## CI

GitHub Actions runs Claude Code for PR reviews. Contributors don't need the `CLAUDE_CODE_OAUTH_TOKEN` secret — CI will run automatically when a maintainer triggers it.
