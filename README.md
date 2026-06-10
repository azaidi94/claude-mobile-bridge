# Claude Mobile Bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.0.23+-black.svg)](https://bun.sh/)

Control Claude Code sessions from your phone via Telegram. Add the bot to a forum group and each session gets its own topic thread — isolated conversations, live streaming, no context switching.

## Features

- **Forum topics** - Each Claude Code session gets its own Telegram topic. Send messages in a topic to talk to that session. The bot creates/deletes topics as sessions come online/offline
- **Mini App (browser UI)** - Telegram Mini App with Chat, Sessions, Tasks (Kanban), Status, and Agents tabs. History replay, live streaming, markdown rendering
- **Auto-discovery** - Detects running Claude Code sessions automatically
- **Channel relay** - Message running desktop sessions without disconnecting them
- **Live streaming** - Watch Claude work in real-time in Telegram and the Mini App: tool calls, tool results (Bash/Grep/Agent/WebFetch promoted, errors always), permission-mode toggles, and stop-hook blocks
- **Unified chat** - Typing in the desktop TUI, a Telegram topic, or the Mini App surfaces in all the others — same conversation, three surfaces, with origin labels (🖥 Desktop / 🌐 Web / 💬 Chat)
- **Voice, photos & documents** - Voice transcribed via OpenAI, photos/PDFs/text files analyzed
- **Extended thinking** - "think" keyword for deeper reasoning, "ultrathink" for 50k tokens
- **Interrupt with `!`** - Prefix message to interrupt current query
- **MCP support** - Configure external tools in `mcp-config.ts`
- **Interactive buttons** - Claude can present options as tappable buttons
- **Remote-answerable AskUserQuestion** - Built-in `AskUserQuestion` cards relay to Telegram and the Web UI via a `PreToolUse` hook; tap an option on mobile (or answer locally) to resolve the desktop's clarifying question — first answer wins.

## Quick Start

### 1. BotFather Config

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

### AskUserQuestion remote bridge (optional)

When Claude Code calls its built-in `AskUserQuestion`, by default it blocks the desktop terminal waiting for a local answer. This bridge surfaces the question on Telegram and the Web UI in parallel — first answer on any surface wins.

**1. Generate a shared secret in `.env`:**

```bash
echo "RELAY_AUQ_SECRET=$(openssl rand -hex 32)" >> .env
```

> **Important**: also export the secret in your shell profile (`~/.bash_profile` or `~/.zshrc`) so the PreToolUse hook can read it when CC spawns it. The bot reads from `.env`, but the hook runs as a child of CC's shell, not the bot.
>
> ```bash
> echo 'export RELAY_AUQ_SECRET="..."' >> ~/.bash_profile  # use the same value as in .env
> ```

**2. Restart the bot** so it picks up the new env var.

**3. Install the hook scripts** — symlinks `hooks/claude-remote-auq-bridge.sh` and `hooks/claude-remote-auq-worker.ts` into `~/.claude/hooks/`:

```bash
bun run install-hooks
```

Symlinks (not copies), so edits in the checkout apply immediately without re-installing.

**4. Register the `PreToolUse` hook** in `~/.claude/settings.json` (replace `<your-username>` with your actual username):

```json
"PreToolUse": [
  {
    "matcher": "AskUserQuestion",
    "hooks": [
      {
        "type": "command",
        "command": "/Users/<your-username>/.claude/hooks/claude-remote-auq-bridge.sh"
      }
    ]
  }
]
```

Drop this inside the existing `"hooks": { ... }` object alongside other entries like `Notification`/`SessionStart`/`Stop`.

**5. Verify**: with the bot running and a Telegram topic watching the project, trigger an `AskUserQuestion` in that project's Claude session — the question card should appear in TG and Web UI within ~2s. Tap an option on mobile or answer locally; the first answer wins.

Requirements:

- Claude Code v2.1.85 or later (uses the `permissionDecision: "allow"` hook contract introduced there)
- tmux (mobile-injected answers use `tmux send-keys` to type into the local TUI pane)
- The bot must be running on the same host as Claude Code (the hook calls `localhost`)

### Exact `/clear` follow for sessions sharing a directory (optional)

When two Claude sessions run in the **same directory**, the relay can only guess (by file mtime/birthtime, with a ≤15s poll) which transcript belongs to which topic after a `/clear`. The `SessionStart` hook removes the guessing: it fires inside each Claude process, so each self-reports its own `session_id` into its own relay port file — exact and instant. It's additive; without it the poll heuristic still works (just slower, and best-effort across siblings).

**1. Install the hook scripts** (same step as the AUQ bridge — symlinks `hooks/*` into `~/.claude/hooks/`):

```bash
bun run install-hooks
```

**2. Register the `SessionStart` hook** in `~/.claude/settings.json` (replace `<your-username>`):

```json
"SessionStart": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "/Users/<your-username>/.claude/hooks/claude-remote-session-id.ts"
      }
    ]
  }
]
```

Drop this inside the existing `"hooks": { ... }` object alongside `PreToolUse`. Covers every session — hand-started and `/new`-launched. Sessions launched via `scripts/claude-relay-launch.sh` (remote `/new`) also get it auto-injected via `--settings`, so this manual step is only needed for hand-started desktop sessions.

> **No hot-reload**: after installing/editing the hook, restart your Claude sessions so they load it. The bot reloads on its own (`bun --watch`).

The hook writes nothing to stdout (SessionStart stdout is injected into Claude's context) and always exits 0. Diagnostics go to `~/.claude/logs/session-id-hook.log`.

## Logs

- `~/Library/Logs/claude-mobile-bridge/bot.log` — primary log, written by the bot itself. Rotates automatically:
  - On every bot restart (existing non-empty bot.log → bot.log.1, shifting older archives up)
  - When size exceeds 10MB
  - Keeps 5 archives (`bot.log.1` through `bot.log.5`); oldest dropped on rotation
- `~/Library/Logs/claude-mobile-bridge/bot-bootstrap.log` — launchd-managed stdout/stderr. Captures bun's startup output and any uncaught errors before the logger initializes. Grows unbounded but typically tiny.

### 3. Create a Forum Group

The bot works best in a **Telegram forum group** where each session gets its own topic:

1. Create a new Telegram group
2. Go to group settings → Topics → enable topics (makes it a forum)
3. Add your bot to the group
4. Promote the bot to admin with **Manage Topics** permission (required to create/delete session topics)
5. The bot auto-detects the forum and starts creating topics for sessions

> **Private chat** also works — you get the classic UI with `/list` and `/switch` buttons. But once the bot detects a forum group, DMs are disabled to avoid split-brain.

## Commands

| Category | Commands                                           |
| -------- | -------------------------------------------------- |
| Sessions | `/list`, `/new`, `/sessions`, `/kill`, `/respawn`  |
| Control  | `/stop`, `/retry`, `/status`, `/model`, `/restart` |
| Files    | `/pwd`, `/cd`, `/ls`                               |
| Quota    | `/usage`                                           |
| Scripts  | `/execute`                                         |
| Mini App | `/app`                                             |
| Settings | `/settings`                                        |

## Channel Relay

The channel relay lets you message a running desktop Claude session from Telegram without disconnecting it. Claude sees your message as a channel notification and replies via the relay — both desktop and mobile stay connected.

**Setup:**

1. Register the relay as a global MCP server (replace the path with your clone location):

```bash
claude mcp add -s user channel-relay -- bun run ~/Dev/claude-mobile-bridge/src/mcp/channel-relay/server.ts
```

2. Start Claude with the relay channel. You need these flags **every time** you launch a session:

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:channel-relay
```

> **Development-channels prompt:** Claude Code will show a menu (“I am using this for local development” vs “Exit”). Choose **1** and press **Enter**. This is required by the CLI; Telegram/`/new` cannot automate it.

### Remote use (you are not at the Mac)

`/new` opens **Terminal on the machine running the bot**. If nobody can click through the dev-channels menu:

1. **Leave a relay-enabled desktop session running** before you go (`/list` → use that session from Telegram). No Terminal prompt until you restart Claude.
2. **Screen Sharing / VNC / Tailscale** to the Mac once to confirm the menu when you must spawn a new session.
3. **Auto-confirm (headless-friendly):** use the bundled expect wrapper and point `.env` at it (requires `/usr/bin/expect`, standard on macOS):

```bash
# Absolute path to this repo on the Mac that runs the bot
export DESKTOP_CLAUDE_COMMAND='/Users/you/claude-mobile-bridge/scripts/claude-relay-launch.sh {dir}'
# If `claude` is not on PATH in Terminal.app, set one of:
# export CLAUDE=/Users/you/.local/bin/claude
# export CLAUDE_CLI_PATH=/Users/you/.local/bin/claude
```

The script answers **1** when it sees the “local development” line, then keeps Claude running. If Anthropic changes the prompt text, update the script or fall back to options 1–2.

> **Tip:** Add a shell alias to avoid typing this each time:
>
> ```bash
> alias cc='claude --dangerously-skip-permissions --dangerously-load-development-channels server:channel-relay'
> ```
>
> `/new` runs `claude` with those flags in a new Terminal (or iTerm) window. Use `DESKTOP_CLAUDE_COMMAND` in `.env` if you prefer a custom shell line (see `.env.example`).

**How it works:** Each relay instance writes a port file to `/tmp/channel-relay-*.json`. The bot scans these to discover relay-enabled sessions and connects over TCP. When a relay is available, the bot routes messages through it. If no relay-enabled desktop session is found, use `/new` to spawn one or `/list` to pick an existing session.

`/status` shows relay connection state. `/list` shows a 📡 indicator on relay-enabled sessions.

## Cursor Integration

Bridge Cursor IDE windows into the same Telegram/Web UI as Claude Code sessions. Messages typed in a Cursor topic inject into Cursor's Composer; AI replies stream back. Each open Cursor workspace becomes its own session with its own topic.

**1. Enable Cursor's remote-debugging port (one-time).** Create or edit `~/.cursor/argv.json`:

```json
{ "remote-debugging-port": 9222 }
```

Then fully quit and relaunch Cursor (`Cmd-Q`, then reopen). No special command-line flags are needed — Cursor reads `argv.json` on every launch, so opening it normally from the Dock, Spotlight, or the CLI all work:

```bash
open -a Cursor                     # default — opens last workspace
open -a Cursor /path/to/project    # open a specific workspace
cursor /path/to/project            # if the `cursor` shell command is installed
```

**2. Enable the bridge in `.env`:**

```bash
CURSOR_BRIDGE_ENABLED=true
# CURSOR_CDP_PORT=9222             # only set if you changed the port above
```

**3. Restart the bot.** It scans `localhost:9222` for Cursor windows, registers a `SessionInfo` per workspace, and the forum topic is auto-created.

**Verify:** `curl -s localhost:9222/json/list` should list Cursor targets. The bot log will show `cursor-bridge: connected to "<workspace>" via CDP` once attached.

Set `CURSOR_BRIDGE_ENABLED=false` (or leave it unset) if Cursor isn't installed — otherwise the bot logs an "Unable to connect" warning loop.

## Mini App

Open the bridge in a browser or inside Telegram as a Mini App. Five tabs:

| Tab      | Purpose                                                                                                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat     | Live terminal-style feed for the active session: history replay, markdown, TUI-style tool headers (Edit diffs, Bash blocks), per-tool result bodies with tap-to-expand, sticky permission-mode banner, hook cards |
| Sessions | List live + offline sessions, tap to activate                                                                                                                                                                     |
| Tasks    | Kanban board of Claude's TodoWrite items — live updates, filter per session or across all                                                                                                                         |
| Status   | CPU / memory / disk / process snapshot of the bot host                                                                                                                                                            |
| Agents   | Spawn a new desktop session into a chosen project directory                                                                                                                                                       |

### Enable

In `.env`:

```bash
WEB_ENABLED=true
WEB_PORT=4242                          # any free port
WEB_URL=http://localhost:4242          # public HTTPS URL in prod
# Optional, for opening in Telegram via deep link:
WEB_APP_SHORT_URL=https://t.me/YourBot/YourShortName
```

Build the frontend once after install and after every pull:

```bash
cd web && bun install && bun run build
```

Dev mode (hot reload):

```bash
cd web && bun run dev   # Vite at :5173, proxies API to WEB_PORT
```

The web server runs inside the main bot process — no separate command. `bun run start` (or `bun run dev` at the repo root) boots both; the bundled frontend at `web/dist/` is served from `WEB_PORT` when `WEB_ENABLED=true`.

Use `/app` from Telegram to get the Mini App link (tap-to-launch button in private chats, plain URL in groups).

### Register the Mini App with BotFather

1. `@BotFather` → `/newapp` → pick your bot → name `Terminal` (or whatever) → short name (e.g. `term`) → icon → short description → **Web App URL**: your `WEB_URL`.
2. Save the deep link (`https://t.me/YourBot/term`) and set it as `WEB_APP_SHORT_URL` in `.env`.
3. Optional menu button: `@BotFather` → `/setmenubutton` → select your bot → `Configure menu button` → paste the `WEB_URL`. Gives a one-tap launcher next to the input bar in private chats.

### Production deployment (HTTPS)

Telegram's mobile clients require HTTPS for Mini App buttons. Reverse-proxy the Hono port:

```nginx
server {
  listen 443 ssl http2;
  server_name bridge.example.com;
  ssl_certificate     /path/fullchain.pem;
  ssl_certificate_key /path/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:4242;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Connection "";      # keeps SSE alive
    proxy_buffering off;                 # SSE needs unbuffered
  }
}
```

Caddy works similarly with a one-liner. The `X-Forwarded-For` header is required for the loopback auth bypass to work safely (see Security below).

## Session Auto-Discovery

Start Claude Code normally and sessions appear in `/list` automatically:

```bash
claude                    # Current directory
claude --cwd ~/code/foo   # Specific directory
```

Or spawn a relay-enabled desktop session from Telegram with `/new` (**macOS**):

```
/new                      # CLAUDE_WORKING_DIR
/new myproject            # Relative to CLAUDE_WORKING_DIR
/new /absolute/path       # Absolute path
```

> Set `CLAUDE_WORKING_DIR` in `.env` to use relative paths with `/new`.

`/new` opens a new window in **Terminal.app** by default. Pick a different
terminal via `DESKTOP_TERMINAL_APP` in `.env`:

| Value      | Launches                                                 |
| ---------- | -------------------------------------------------------- |
| `Terminal` | macOS Terminal.app (default)                             |
| `iTerm2`   | iTerm2 via AppleScript                                   |
| `Ghostty`  | Ghostty.app                                              |
| `cmux`     | cmux.app workspace — must have the `cmux` CLI on `$PATH` |

Resume an offline session (one with JSONL history but no live process) with `/sessions`. The bot lists recent project directories within `ALLOWED_PATHS`, shows the last message preview, and tapping Resume opens Terminal in that directory and starts `claude` with the channel-relay flags (same as `/new`).

## Shell Scripts (`/execute`)

`/execute` shows inline Start/Stop buttons for any shell scripts listed in `execute-commands.json` — handy for toggling a VPN, port-forward, or other long-running helper from your phone. Copy the example and edit:

```bash
cp execute-commands.example.json execute-commands.json
```

```json
[
  { "name": "VPN", "script": "/absolute/path/to/connect-vpn.sh" },
  { "name": "Tunnel", "script": "/absolute/path/to/tunnel.sh" }
]
```

Scripts run detached; Start/Stop liveness is tracked by PID. Override the config location with `EXECUTE_COMMANDS_FILE` in `.env`.

## Settings (`/settings`)

`/settings` opens a persistent settings panel with tap-to-edit fields:

| Field            | Effect                                                              |
| ---------------- | ------------------------------------------------------------------- |
| 🖥 Terminal      | Terminal used by `/new` and `/sessions → Resume`                    |
| 📁 Working dir   | Default project dir for `/new` (when no arg given)                  |
| 👁 Auto-watch    | Whether `/new` auto-attaches a watch after spawn                    |
| 🤖 Model         | Default model — shares state with `/model`                          |
| 📌 Pinned status | Pin status messages in topics (`enablePinnedStatus`, default: true) |

Values live in `~/.claude-mobile-bridge/settings.json` and override the matching `.env` values. Tap **↺ Reset to default** on any sub-menu to drop the override and fall back to the env value. Auto-watch cycles `default → off → on → default` on each tap.

## Development

```bash
bun run dev          # Run with file watching
bun run typecheck    # TypeScript type checking
bun run test         # Run all tests (isolated per-file to avoid state leaks)
```

## Running as a Service (macOS)

```bash
cp scripts/launchagent/com.claude-telegram-ts.plist.template ~/Library/LaunchAgents/com.claude-telegram-ts.plist
# Edit plist with your paths
launchctl load ~/Library/LaunchAgents/com.claude-telegram-ts.plist
```

## Security

See [SECURITY.md](SECURITY.md). User allowlist, path validation, command safety checks, rate limiting, and audit logging.

### Mini App auth

Every `/api/*` request is validated against Telegram's `initData` HMAC (signed with your bot token). The Mini App sends it automatically. Three env flags control overrides:

| Flag                       | Default | Effect                                                                                                                                                                                                                                                                    |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEB_AUTH_BYPASS=true`     | false   | **Nuclear bypass.** All requests allowed. Only safe if `WEB_URL` is strictly localhost                                                                                                                                                                                    |
| `WEB_AUTH_LAN_BYPASS=true` | false   | Allows direct-to-port requests from loopback (`127.0.0.1` / `::1`) and RFC 1918 LAN addresses **only when** `X-Forwarded-For`/`X-Real-IP` is absent. Safe behind a reverse proxy — the proxy always sets those headers, so public traffic keeps going through normal auth |

Prefer `WEB_AUTH_LAN_BYPASS` for local and LAN access. It lets requests from the bot host or other devices on your network succeed while rejecting unauthenticated public traffic.

The bot prints a loud startup warning if `WEB_AUTH_BYPASS=true` is set with a non-localhost `WEB_URL`.

## License

MIT
