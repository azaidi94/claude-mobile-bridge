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

4. **Ask the user** if they'd like a shell alias (`cc`) added for launching Claude with the relay flags. If yes:
   - Detect the user's shell config file (`~/.zshrc`, `~/.bashrc`, or `~/.bash_profile`)
   - Check if an alias for `cc` already exists — if so, skip
   - Append: `alias cc='claude --dangerously-skip-permissions --dangerously-load-development-channels server:channel-relay'`
   - Tell the user to run `source ~/.zshrc` (or equivalent) to load it

5. **Verify** by running `claude mcp list` and confirming `channel-relay` appears.

6. **Print a summary** of what was done and how to use it:
   - Start a session with `cc` (or the full command)
   - The bot auto-discovers relay sessions via `/list`
   - Use `/watch` to stream live, type messages to send via relay
