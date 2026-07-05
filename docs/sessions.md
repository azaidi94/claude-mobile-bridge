# Sessions & shell scripts

[← README](../README.md)

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
