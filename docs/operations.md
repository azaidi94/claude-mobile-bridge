# Operations

[← README](../README.md)

Logs, running as a service, and the `/settings` panel.

## Logs

- `~/Library/Logs/claude-mobile-bridge/bot.log` — primary log, written by the bot itself. Rotates automatically:
  - On every bot restart (existing non-empty bot.log → bot.log.1, shifting older archives up)
  - When size exceeds 10MB
  - Keeps 5 archives (`bot.log.1` through `bot.log.5`); oldest dropped on rotation
- `~/Library/Logs/claude-mobile-bridge/bot-bootstrap.log` — launchd-managed stdout/stderr. Captures bun's startup output and any uncaught errors before the logger initializes. Grows unbounded but typically tiny.

## Running as a Service (macOS)

```bash
cp scripts/launchagent/com.claude-telegram-ts.plist.template ~/Library/LaunchAgents/com.claude-telegram-ts.plist
# Edit plist with your paths
launchctl load ~/Library/LaunchAgents/com.claude-telegram-ts.plist
```

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
