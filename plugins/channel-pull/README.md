# channel-pull

Lets **Claude desktop app** sessions (Code tab) receive Telegram messages from the [channel relay](../../docs/channel-relay.md).

## Why

The relay normally delivers inbound messages as `notifications/claude/channel`. Those only reach Claude when the session was launched with `--dangerously-load-development-channels server:channel-relay` (the `cc` alias). The desktop app launches `claude` with its own args, so the flag can't be passed and messages are dropped.

## How

```
Telegram ─► bot ─TCP─► channel-relay ─unix socket─► channel-pull (this mod) ─► $.prompt.submit
```

- The relay checks its parent `claude`'s command line. Without the channels flag it also serves a long-poll inbox on `~/.claude-mobile-bridge/relay-<pid>.sock` (mode 0600) and records it as `pullSocket` in its port file.
- On `session.start` the mod finds the newest port file whose `sessionId` matches its session and long-polls `GET /inbox` on a `$.clock.after` timer chain (8s per poll, retry every 5s when there's no relay); a reload drops the timers, so only one copy ever polls.
- Each message is submitted as a prompt wrapped in the same tag a CLI session gets (`<channel source="channel-relay" chat_id=… request_id=… user=…>`). It's submitted `asUser`, so the model reads it unframed. Replies, `reply` attachments and `ask_remote` go through the relay's MCP tools exactly as in the CLI.
- Without channels the relay routes every message to the inbox (a notification would be dropped), so each message is delivered once. Messages that arrive before the first poll wait there for up to 10 minutes (the relay's request-id lifetime); the relay logs a warning when one is queued with no poller. In a `cc` session (channels on) the relay offers no socket and the mod stands down.

**Companion: `channel-pull-format`.** The desktop app draws the "Message from channel-relay" card only for a real channel origin, and no plugin can set one, so a relayed prompt would show its raw `<channel …>` tag. [`channel-pull-format`](../channel-pull-format/hooks/register.ts) rewrites channel-pull's prompts to show just `📱 <message>` and passes the tag to the model as hidden context. It's a separate plugin so the cosmetic part stays opt-in; the context it adds restates the relay's routing rules (answer as text, `ask_remote` for questions), since the model no longer sees the tag in the prompt itself.

Messages that arrive mid-turn queue and run once the session goes idle (channel notifications in the CLI land in the running turn instead).

## Install

Requires the relay registered as a user MCP server (see the main README). Then, from a terminal:

```bash
claude plugin marketplace add azaidi94/claude-mobile-bridge
```

```bash
claude plugin install channel-pull@claude-mobile-bridge
```

```bash
claude plugin install channel-pull-format@claude-mobile-bridge
```

From a local clone, use the clone's path in place of `azaidi94/claude-mobile-bridge`. Installed at user scope, it loads in every new desktop-app session. Sessions that were already open don't have it: start a new session (the plugin starts polling on `session.start`).

## Not covered on desktop

- Remote tool-permission cards (`claude/channel/permission`): these need channels. In a session that isn't in bypass mode, an approval prompt can only be answered in the app.
- Anything that types into a terminal (tmux, cmux, Cursor) can't reach the app: `/clear`, `/compact`, `/context` and `/model` injection, the `/claude` menu's commands, `/skills` injection, and tapping answers to a native AskUserQuestion. Questions asked with `ask_remote` work.

## Develop

```bash
claude plugin validate plugins/channel-pull
```

```bash
claude plugin test plugins/channel-pull
```

```bash
claude plugin test plugins/channel-pull-format
```

Relay side: `src/mcp/channel-relay/pull-inbox.ts` (+ `pull-inbox.test.ts`).
