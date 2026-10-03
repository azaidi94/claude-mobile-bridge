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

## Branching and resuming (`/new --branch`, `/new --resume`)

- `/new` with no arguments opens a button menu: open a folder, branch a
  session, or resume a conversation (see [menus.md](menus.md)).
- `/new --branch` — run inside a session topic. Starts a **new** desktop
  Claude in that session's folder with `--resume <its id> --fork-session`,
  so the fork gets a fresh session id and its own topic (e.g. `kx_repo-2`)
  while the original keeps running. This is what people usually mean by
  "branch"; Claude Code's own `/branch` forks _in place_ instead and does
  not create a second session.
- `/new --resume <id> [path]` — starts a desktop Claude on a dormant
  transcript. The folder defaults to the transcript's recorded cwd. Refused
  when that id is already live somewhere (two processes would write one
  transcript) — branch it from its topic instead.
- `/sessions` → `▶️ Resume` now resumes the transcript it shows (it used to
  open a fresh session in that folder).

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
