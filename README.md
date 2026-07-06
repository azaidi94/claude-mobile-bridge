# Claude Mobile Bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.0.23+-black.svg)](https://bun.sh/)

Control Claude Code sessions from your phone via Telegram. Add the bot to a forum group and each session gets its own topic thread — isolated conversations, live streaming, no context switching.

## Features

- **Forum topics** — each Claude Code session gets its own Telegram topic; the bot creates/deletes them as sessions come online/offline.
- **[Mini App](docs/mini-app.md)** — browser/Telegram Mini App with Chat, Sessions, Tasks (Kanban), Status, and Agents tabs.
- **[Auto-discovery](docs/sessions.md)** — detects running Claude Code sessions automatically.
- **[Channel relay](docs/channel-relay.md)** — message running desktop sessions without disconnecting them.
- **Live streaming** — watch tool calls, results, permission-mode toggles, and stop-hook blocks in real time.
- **Unified chat** — desktop TUI, Telegram topic, and Mini App share one conversation with origin labels (🖥 Desktop / 🌐 Web / 💬 Chat).
- **Voice, photos & documents** — voice transcribed via OpenAI; photos/PDFs/text analyzed.
- **Extended thinking** — `think` for deeper reasoning, `ultrathink` for 50k tokens.
- **Interrupt with `!`** — prefix a message to interrupt the current query.
- **Remote slash commands** — `/clear`, `/compact`, and `/context` typed straight into the desktop session's TUI.
- **[Ralph loops](docs/ralph-loops.md)** — `/ralph <repo>` runs an autonomous issue-crunching loop in a desktop terminal; distilled per-iteration beats stream to a dedicated topic.
- **[Remote-answerable AskUserQuestion](docs/advanced-hooks.md)** — clarifying-question cards relay to Telegram/Web; tap to answer, first answer wins.
- **[Cursor integration](docs/cursor.md)** — bridge Cursor IDE windows into the same Telegram/Web UI.
- **MCP support** — configure external tools in `mcp-config.ts`.

## Quick Start

> **Shortcut:** already have the [Claude Code CLI](https://claude.com/code)? Clone the repo, run `bun install`, then open `claude` in the repo and run **`/setup`** — it walks the whole flow below interactively (`.env`, relay registration, optional hooks), idempotently. The manual steps follow for reference or if you'd rather do it by hand.

### 1. BotFather config

1. Open @BotFather → `/newbot` (or select an existing bot) and grab the token
2. Bot Settings → enable "Topics in Groups"
3. Optional: Group Privacy → disable (so bot sees all messages in topics)

### 2. Install

**Prerequisites:** [Bun 1.0.23+](https://bun.sh/), [Claude Code CLI](https://claude.com/code), [Telegram Bot Token](https://t.me/botfather)

```bash
git clone https://github.com/azaidi94/claude-mobile-bridge.git
cd claude-mobile-bridge
bun install
cp .env.example .env              # Edit with your credentials
cp mcp-config.example.ts mcp-config.ts  # Optional: configure MCP tools
bun run start
```

Required `.env` variables:

```bash
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_ALLOWED_USERS=123456789  # Your Telegram user ID (get from @userinfobot)
```

See `.env.example` for all options (working dir, allowed paths, voice transcription, rate limits, etc).

### 3. Create a forum group

The bot works best in a **Telegram forum group** where each session gets its own topic:

1. Create a new Telegram group
2. Go to group settings → Topics → enable topics (makes it a forum)
3. Add your bot to the group
4. Promote the bot to admin with **Manage Topics** permission (required to create/delete session topics)
5. The bot auto-detects the forum and starts creating topics for sessions

> **Private chat** also works — you get the classic UI with `/list` and `/switch` buttons. But once the bot detects a forum group, DMs are disabled to avoid split-brain.

### 4. Connect your desktop sessions (channel relay)

The bot can run its own sessions out of the box, but the main use case — messaging the Claude Code session **already running on your desktop**, without disconnecting it — needs the channel relay. Discovery can _see_ a plain `claude` process, but only a relay-enabled session can be driven from your phone.

1. Register the relay as a global MCP server (replace the path with your clone location):

   ```bash
   claude mcp add -s user channel-relay -- bun run ~/Dev/claude-mobile-bridge/src/mcp/channel-relay/server.ts
   ```

2. Launch each session with the relay channel — you need these flags **every time**, so alias them:

   ```bash
   claude --dangerously-skip-permissions --dangerously-load-development-channels server:channel-relay

   # or add to ~/.zshrc / ~/.bash_profile:
   alias cc='claude --dangerously-skip-permissions --dangerously-load-development-channels server:channel-relay'
   ```

   > Claude Code shows a one-time menu (“I am using this for local development” vs “Exit”). Choose **1**, press **Enter**.

That session now appears in `/list` with a 📡 indicator and is messageable from its topic. See [Channel Relay](docs/channel-relay.md) for remote/headless launching (you're not at the Mac) and how it works.

That's the full setup. For optional integrations (remote-answerable questions, exact `/clear` follow, Cursor, the Mini App), see [Documentation](#documentation) below.

## Commands

| Category   | Commands                                           |
| ---------- | -------------------------------------------------- |
| Sessions   | `/list`, `/new`, `/sessions`, `/kill`, `/respawn`  |
| Control    | `/stop`, `/retry`, `/status`, `/model`, `/restart` |
| Inject     | `/clear`, `/compact`, `/context`                   |
| Automation | `/ralph <path> [N]`, `/cron`                       |
| Files      | `/pwd`, `/cd`, `/ls`                               |
| Quota      | `/usage`                                           |
| Scripts    | `/execute`                                         |
| Mini App   | `/app`                                             |
| Settings   | `/settings`                                        |

## Documentation

| Doc                                          | What's in it                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Channel Relay](docs/channel-relay.md)       | Message running desktop sessions without disconnecting; remote-use setup                   |
| [Sessions & shell scripts](docs/sessions.md) | Auto-discovery, `/new`, terminal picker, resuming offline sessions, `/execute`             |
| [Mini App](docs/mini-app.md)                 | Browser/Telegram UI: tabs, enable, BotFather registration, HTTPS deployment, auth          |
| [Advanced hooks](docs/advanced-hooks.md)     | Remote-answerable `AskUserQuestion` bridge + exact `/clear` follow (`SessionStart`)        |
| [Ralph loops](docs/ralph-loops.md)           | `/ralph` — run `afk_tasks.sh` from Telegram: start/watch/stop, verbose mode, customization |
| [Cursor Integration](docs/cursor.md)         | Bridge Cursor IDE windows into the same Telegram/Web UI                                    |
| [Operations](docs/operations.md)             | Logs, running as a launchd service, `/settings` reference                                  |
| [Security](SECURITY.md)                      | Allowlist, path validation, command safety, rate limiting, audit logging                   |

## Development

```bash
bun run dev          # Run with file watching
bun run typecheck    # TypeScript type checking
bun run test         # Run all tests (isolated per-file to avoid state leaks)
```

## Security

See [SECURITY.md](SECURITY.md): user allowlist, path validation, command safety checks, rate limiting, and audit logging. Mini App request auth (Telegram `initData` HMAC) and the LAN-bypass flags are covered in [Mini App auth](docs/mini-app.md#mini-app-auth).

## License

MIT
