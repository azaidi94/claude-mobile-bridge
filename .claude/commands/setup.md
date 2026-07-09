---
description: One-shot setup for claude-mobile-bridge — prereqs, .env, relay, hooks
allowed-tools: Bash, Read, Glob, Edit, Write
---

Set up claude-mobile-bridge end-to-end so the user can drive their desktop Claude sessions from Telegram. Work through the steps **in order**, reporting concisely after each. Everything here is **idempotent** — detect what's already done and skip it; never duplicate. Prefer the repo's scripts over hand-edits.

Stop and ask the user only at the decision points called out below (filling secrets, opt-in features, shell alias). Don't ask permission for read-only checks.

## 0. Locate repo + prerequisites

- Repo root = the directory containing a `package.json` whose name is `claude-mobile-bridge` (this project dir, or its parent). Confirm `src/mcp/channel-relay/server.ts` exists under it.
- Check `bun --version` and `claude --version`. If either is missing, tell the user how to install it (Bun: https://bun.sh, Claude Code: https://claude.com/code) and stop — nothing else works without them.

## 1. Dependencies

- If `node_modules/` is absent, run `bun install` from the repo root.

## 2. `.env`

- If `.env` doesn't exist, `cp .env.example .env`.
- Read `.env`. Inspect the two **required** vars: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USERS`. If either is empty or still the placeholder from `.env.example`, **ask the user** for the value:
  - `TELEGRAM_BOT_TOKEN` — from @BotFather (`/newbot` or pick an existing bot).
  - `TELEGRAM_ALLOWED_USERS` — their numeric Telegram user ID, from @userinfobot.
  - Write the answers into `.env` (replace the line, don't append a duplicate).
- Mention the two **recommended** optional vars and offer to set them: `CLAUDE_WORKING_DIR` (project Claude runs in) and `OPENAI_API_KEY` (voice transcription). Don't block on them.
- Remind the user that in @BotFather they must enable **Bot Settings → Topics in Groups** for the forum flow.

## 3. Channel relay (the main use case)

This is what lets the bot message an already-running desktop session.

- Check if registered: `claude mcp list 2>/dev/null | grep channel-relay`. If present, say so and skip the add.
- If absent: `claude mcp add -s user channel-relay -- bun run <REPO_ROOT>/src/mcp/channel-relay/server.ts` (use the actual absolute repo path).
- **Ask** whether to add a shell launcher for the relay flags, and if so **which variant** — plain or tmux (`cct`). Detect the shell rc (`~/.zshrc`, `~/.bashrc`, or `~/.bash_profile` per `$SHELL`), skip if the chosen name already exists, else append it and tell them to `source` it.
  - **Plain `cc`** — simplest:
    `alias cc='claude --dangerously-skip-permissions --dangerously-load-development-channels server:channel-relay'`
  - **tmux launcher `cct`** (recommended) — runs each session inside tmux on the dedicated `claude` socket via the shipped `scripts/tmux/launch.sh`, so: the bot injects `/clear`·`/compact`·`/context` via `tmux send-keys` (accessibility-free, works in any terminal incl. Cursor); the `/tmux` panel + `/peek` work; and you can run **multiple sessions per folder** (hybrid reattach-or-create), each routed to its own topic. Also satisfies the AUQ bridge's tmux dependency (step 4). Requires `tmux` (`command -v tmux` — warn if missing) **and** the SessionStart identity hook (step 4) for the multi-session routing. Append a shell **function** (not an alias), substituting the absolute repo path:
    ```bash
    cct() {
      source "<REPO_ROOT>/scripts/tmux/launch.sh"
      cc_tmux_launch "$#" --dangerously-skip-permissions \
        --dangerously-load-development-channels server:channel-relay "$@"
    }
    ```
    Mention the optional `CCT_MODE` env (`hybrid` default · `attach` · `create`) they can set in the same profile to change the reuse policy.
  - **Flag the trade-off when asking:** either launcher permanently runs Claude with `--dangerously-skip-permissions` (no permission prompts) — convenient for the relay flow, but any prompt-injection in such a session then has unrestricted tool access. Let the user opt in knowingly.

## 4. Advanced hooks (optional, recommended)

- **Ask** whether to enable the advanced hooks (exact `/clear` follow + the AskUserQuestion → Telegram bridge). Both are additive and inert until opted into.
- If yes:
  - Run `bun run install-hooks` (symlinks the hook scripts **and** idempotently registers both `~/.claude/settings.json` entries, backing it up first).
  - For the AskUserQuestion bridge, run `bun run setup-auq-secret` (writes the same secret to `.env` and the shell profile). Tell the user to `source` the profile it edited.
  - The AUQ bridge also needs **tmux**, **Claude Code ≥ v2.1.85**, and the bot running on the **same host** (it calls `localhost`). Check `command -v tmux` and warn if missing — the bridge is inert without these, so the `/clear` follow still works either way. If the user took the `cct` tmux launcher in step 3, this tmux dependency is already covered. See [docs/advanced-hooks.md](../../docs/advanced-hooks.md).
  - Note: hooks have **no hot-reload** — they must restart their hand-started Claude sessions to load them. The bot reloads itself.

## 5. Forum group (manual — Telegram app)

Setup can't do this part; hand it off clearly:

1. Create a Telegram group → settings → **Topics** → enable (makes it a forum).
2. Add the bot, promote to **admin** with **Manage Topics** permission.
3. The bot auto-detects the forum and starts creating a topic per session.

(A private DM also works for the classic `/list`/`/switch` UI, but once a forum is detected DMs are disabled.)

## 6. Summary

Print what was done vs. skipped, then the start sequence:

1. `bun run start` (the bot).
2. In any project, launch a session with `cc` (or `cct` for tmux-backed injection + `/tmux`/`/peek` + multi-session, or the full flags).
3. On Telegram, `/list` shows the session with 📡 — message it from its topic.

List anything still pending (required `.env` vars not provided, forum group not yet created, profile not yet `source`d, sessions needing restart for hooks).
