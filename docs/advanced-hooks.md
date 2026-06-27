# Advanced hooks (optional)

[← README](../README.md)

Two optional Claude Code hooks that sharpen the bridge. Both are additive — the bot works without them.

- **AskUserQuestion remote bridge** — surface Claude's clarifying-question cards on Telegram/Web.
- **Exact `/clear` follow** — make sessions self-report their `session_id` so the relay never guesses which transcript belongs to which topic.

Both use the same hook scripts, installed once via `bun run install-hooks`.

## AskUserQuestion remote bridge

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

## Exact `/clear` follow for sessions sharing a directory

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
