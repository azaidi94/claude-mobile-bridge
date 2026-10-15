# bridge

claude-mobile-bridge inside the **Claude desktop app** (Code tab):

- **Telegram in:** messages from a session's Telegram topic arrive as prompts (desktop sessions can't load channels, so the [channel relay](../../docs/channel-relay.md) can't push them).
- **Status band** above the prompt, with warnings when they matter: `⚠️ bridge bot not answering`, `⚠️ no channel-relay for this session` / `channel-relay not answering`, `⚠️ two pollers on this session's relay`.
- **`/bridge status`:** bot, this session's topic (with a `t.me` link), relay and poll state.
- **Details in the band:** in the desktop app the band always shows one line (`● bridge · connected · <topic> · 📱 2m ago`, or the warning). **details ▾** expands it: bot, topic with an Open topic link, relay, last phone message, the latest 5 phone messages, and the last doctor run, with Run doctor and Refresh buttons. In the terminal the band shows only on a warning, or for 15 minutes after a phone message.
- **`/bridge doctor`:** checks the bot answers, finds duplicate bot processes, whether the bot tracks this session and has a topic for it, whether the relay is up and polled, old plugins still enabled, `bridge-format` missing, and recent `[ERROR]`s in `bot.log`. Each problem says what to do.

Install it with its companion **`bridge-format`**, which shows relayed prompts as `📱 <message>` instead of the raw `<channel …>` tag. It has to be a separate plugin: `$.prompt.submit` takes no hidden context, and the engine keeps a plugin's own hooks off the prompts it submits.

## Install

Requires the relay registered as a user MCP server (see the main README) and the bot running. Then, from a terminal:

```bash
claude plugin marketplace add azaidi94/claude-mobile-bridge
```

```bash
claude plugin install bridge@claude-mobile-bridge
```

```bash
claude plugin install bridge-format@claude-mobile-bridge
```

From a local clone, use the clone's path in place of `azaidi94/claude-mobile-bridge`. In the desktop app: + next to the prompt box → Plugins → Add marketplace / Add plugin. Installed at user scope, it loads in every new session; sessions already open need a new session or `/reload-plugins`.

**Replacing `channel-pull`:** uninstall `channel-pull` and `channel-pull-format` first. With both installed the two pollers keep cutting each other's long-poll short; bridge backs off, and its band and `/bridge doctor` say so. If you added the marketplace before `bridge` existed, run `claude plugin marketplace update claude-mobile-bridge` before installing.

```bash
claude plugin uninstall channel-pull@claude-mobile-bridge
```

```bash
claude plugin uninstall channel-pull-format@claude-mobile-bridge
```

## How

```
Telegram ─► bot ─TCP─► channel-relay ─unix socket─► bridge ─► $.prompt.submit ─► bridge-format (📱)
                bot.sock (status) ◄────────────────── bridge (band, /bridge)
```

- **Inbound.** The relay checks its parent `claude`'s command line. Without the channels flag it serves a long-poll inbox on `~/.claude-mobile-bridge/relay-<pid>.sock` (mode 0600), named as `pullSocket` in its port file, and queues every message there (up to 10 minutes: the relay's request-id lifetime). The mod finds the newest port file whose `sessionId` matches its session and long-polls `GET /inbox` on a `$.clock.after` timer chain (8s per poll, retry every 5s); a reload drops the timers, so only one copy ever polls. Each message is submitted `asUser`, wrapped in the same `<channel source="channel-relay" chat_id=… request_id=… user=…>` tag a CLI session gets, so `reply`, attachments and `ask_remote` work as in the CLI. In a `cc` session (channels on) the relay offers no socket and the mod stands down.
- **Status.** Every 15s the mod asks the bot's control socket, `~/.claude-mobile-bridge/bot.sock` (mode 0600, read-only: `GET /status`, `GET /session/<id>`; see `src/control/server.ts`), what it knows about this session.

`CLAUDE_TELEGRAM_STATE_DIR` (the bot's and relay's state folder) and `CLAUDE_TELEGRAM_LOG_DIR` are read from this session's environment: if you set them in the bot's `.env` only, set them for Claude too, or the mod looks in the defaults.

Messages that arrive mid-turn queue and run once the session goes idle (channel notifications in the CLI land in the running turn instead).

## Not covered on desktop

- Restarting the bot: it has to run inside cmux, which a desktop session can't reach. The band and `/bridge doctor` say when it's down.
- Remote tool-permission cards (`claude/channel/permission`): these need channels. In a session that isn't in bypass mode, an approval prompt can only be answered in the app.
- Anything that types into a terminal (tmux, cmux, Cursor) can't reach the app: `/clear`, `/compact`, `/context` and `/model` injection, the `/claude` menu's commands, `/skills` injection, and tapping answers to a native AskUserQuestion. Questions asked with `ask_remote` work.

## Develop

```bash
claude plugin validate plugins/bridge
```

```bash
claude plugin test plugins/bridge
```

```bash
claude plugin test plugins/bridge-format
```

`bun run test` runs both when the `claude` CLI is installed. Pure logic (prompt format, band, status and doctor text) is in `hooks/core.ts`; `hooks/register.tsx` does the I/O. Relay side: `src/mcp/channel-relay/pull-inbox.ts`; bot side: `src/control/server.ts`. Bump `version` in `plugin.json` on every change: installs from GitHub only update on a new version.
