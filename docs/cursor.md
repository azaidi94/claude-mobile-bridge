# Cursor Integration

[← README](../README.md)

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
