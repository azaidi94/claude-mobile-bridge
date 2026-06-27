# Advanced hooks (optional)

[← README](../README.md)

Two optional Claude Code hooks that sharpen the bridge. Both are additive — the bot works without them.

- **AskUserQuestion remote bridge** — surface Claude's clarifying-question cards on Telegram/Web.
- **Exact `/clear` follow** — make sessions self-report their `session_id` so the relay never guesses which transcript belongs to which topic.

## Install (one command, registers both)

A single command symlinks `hooks/*` into `~/.claude/hooks/` **and** idempotently registers both entries (`PreToolUse` → AUQ bridge, `SessionStart` → session-id reporter) in `~/.claude/settings.json`:

```bash
bun run install-hooks
```

- **Idempotent** — re-running is safe; it backs up `settings.json` (`settings.json.bak-<timestamp>`) before any change and skips entries already present (matched by command name, so a prior hand-edit won't duplicate).
- **Symlinks, not copies** — edits in the checkout apply immediately, no re-install.
- **Inert until you opt in** — neither hook does anything until enabled. Without `RELAY_AUQ_SECRET` the `PreToolUse` hook just passes through to the local TUI; `SessionStart` only writes to its own log.

> **No hot-reload**: after installing, restart your Claude sessions so they load the hooks. The bot reloads on its own (`bun --watch`).

To register the entries without re-symlinking, run `bun run register-hooks`.

## AskUserQuestion remote bridge

When Claude Code calls its built-in `AskUserQuestion`, by default it blocks the desktop terminal waiting for a local answer. This bridge surfaces the question on Telegram and the Web UI in parallel — first answer on any surface wins.

The `PreToolUse` hook is already registered by `bun run install-hooks` (above). To activate the bridge:

**1. Generate + place the shared secret** — the secret must live in **two** places with the **same** value: `.env` (read by the bot) and your shell profile (`export`, read by the hook, since it runs as a child of CC's shell, not the bot). One command does both:

```bash
bun run setup-auq-secret
```

It reconciles the two locations (reuses an existing value, or generates one), backs up the shell profile, and prints the `source` command to reload it. Re-run anytime; `--force-new` rotates the secret. Then `source` the profile it edited (or open a new terminal).

<details><summary>Prefer to do it by hand?</summary>

```bash
echo "RELAY_AUQ_SECRET=$(openssl rand -hex 32)" >> .env
# then export the SAME value in your shell profile:
echo 'export RELAY_AUQ_SECRET="<same value as in .env>"' >> ~/.zshrc
```

</details>

**2. Restart the bot** so it picks up the new env var, and restart your Claude sessions so the hook reads the exported secret.

**3. Verify**: with the bot running and a Telegram topic watching the project, trigger an `AskUserQuestion` in that project's Claude session — the question card should appear in TG and Web UI within ~2s. Tap an option on mobile or answer locally; the first answer wins.

Requirements:

- Claude Code v2.1.85 or later (uses the `permissionDecision: "allow"` hook contract introduced there)
- tmux (mobile-injected answers use `tmux send-keys` to type into the local TUI pane)
- The bot must be running on the same host as Claude Code (the hook calls `localhost`)

## Exact `/clear` follow for sessions sharing a directory

When two Claude sessions run in the **same directory**, the relay can only guess (by file mtime/birthtime, with a ≤15s poll) which transcript belongs to which topic after a `/clear`. The `SessionStart` hook removes the guessing: it fires inside each Claude process, so each self-reports its own `session_id` into its own relay port file — exact and instant. It's additive; without it the poll heuristic still works (just slower, and best-effort across siblings).

The `SessionStart` hook is already registered by `bun run install-hooks` (above) — it covers every session, hand-started and `/new`-launched. Just **restart your hand-started desktop sessions** so they load it. Sessions launched via `scripts/claude-relay-launch.sh` (remote `/new`) also get it auto-injected via `--settings`.

The hook writes nothing to stdout (SessionStart stdout is injected into Claude's context) and always exits 0. Diagnostics go to `~/.claude/logs/session-id-hook.log`.

## Manual registration (fallback)

`bun run install-hooks` does this for you. Register by hand only if you skipped it or the script couldn't run. Drop these inside the existing `"hooks": { ... }` object in `~/.claude/settings.json` (replace `<your-username>`):

```json
"PreToolUse": [
  {
    "matcher": "AskUserQuestion",
    "hooks": [
      { "type": "command", "command": "/Users/<your-username>/.claude/hooks/claude-remote-auq-bridge.sh" }
    ]
  }
],
"SessionStart": [
  {
    "hooks": [
      { "type": "command", "command": "/Users/<your-username>/.claude/hooks/claude-remote-session-id.ts" }
    ]
  }
]
```
