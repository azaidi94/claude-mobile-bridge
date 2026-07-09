---
description: Set up channel relay for desktop Claude sessions
allowed-tools: Bash, Read, Glob
---

Set up the channel-relay MCP server so desktop Claude sessions can communicate with the Telegram bot.

## Steps

1. **Find the repo root** by looking for `src/mcp/channel-relay/server.ts` relative to this project directory.

2. **Check if already registered:**

   ```bash
   claude mcp list 2>/dev/null | grep channel-relay
   ```

   If already registered, tell the user and skip to step 4.

3. **Register the relay as a global MCP server:**

   ```bash
   claude mcp add -s user channel-relay -- bun run <REPO_ROOT>/src/mcp/channel-relay/server.ts
   ```

   Replace `<REPO_ROOT>` with the actual absolute path to this repo.

4. **Ask the user** if they'd like a shell launcher added for the relay flags. If yes, detect the shell config (`~/.zshrc`, `~/.bashrc`, or `~/.bash_profile`), skip if the name already exists, else append and tell them to `source` it:
   - **Plain `cc`** (simplest): `alias cc='claude --dangerously-skip-permissions --dangerously-load-development-channels server:channel-relay'`
   - **tmux `cct`** (recommended — enables `tmux send-keys` injection, the `/tmux` panel, `/peek`, and multiple sessions per folder). Append a **function** with the absolute repo path:
     ```bash
     cct() {
       source "<REPO_ROOT>/scripts/tmux/launch.sh"
       cc_tmux_launch "$#" --dangerously-skip-permissions \
         --dangerously-load-development-channels server:channel-relay "$@"
     }
     ```
     Multi-session routing also needs the SessionStart identity hook (`bun run install-hooks`).

5. **Verify** by running `claude mcp list` and confirming `channel-relay` appears.

6. **Print a summary** of what was done and how to use it:
   - Start a session with `cc` (or `cct` for the tmux launcher, or the full command)
   - The bot auto-discovers relay sessions via `/list`
   - Use `/watch` to stream live, type messages to send via relay
