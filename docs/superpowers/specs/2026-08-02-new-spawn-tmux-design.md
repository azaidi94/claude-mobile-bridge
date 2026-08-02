# /new remote spawns run under tmux — design

**Date:** 2026-08-02 · **Status:** approved (conversation, 2026-07-31 + 2026-08-02)

## Problem

Sessions spawned remotely via `/new` run a bare `claude` inside the cmux
workspace (`DESKTOP_CLAUDE_COMMAND` → `scripts/claude-relay-launch.sh`). They
never touch the `cc`/`cct` alias path, so they don't get the `tmux -L claude`
wrapping. Consequence: no `tmuxPane`/`tmuxSocket` in the relay port file, so
the preferred accessibility-free injection route (`tmux send-keys` for
`/clear` `/compact` `/context`, commit 255e2b9) cannot target them — the bot
falls back to fragile app-specific keystroke injection or fails.

The bot side needs **zero changes**: the relay MCP server already records
`$TMUX_PANE`/`$TMUX` from its own environment into the port file
(`src/mcp/channel-relay/server.ts`), and `terminal-inject` consumes it.

## Decision: tmux outside, expect inside ("option B")

`claude-relay-launch.sh` gains a two-phase structure:

1. **Outer phase** (no `CC_RELAY_INNER` marker): if `tmux` is on PATH, we are
   not already inside tmux (`$TMUX` empty), and `CLAUDE_CODE_NO_TMUX != 1`,
   re-exec the script inside a fresh tmux session on the dedicated socket:
   `tmux -L claude -f scripts/claude-tmux.conf new-session -s <name> '<self> <dir>'`
   with `CC_RELAY_INNER=1` exported. Session naming and the stale-orphan
   `kill-session` guard reuse `scripts/tmux/launch.sh` helpers
   (`_cc_launch_name`, socket + conf constants). If tmux is unavailable, fall
   through to the inner phase directly — behavior identical to today.
2. **Inner phase** (`CC_RELAY_INNER=1`, or tmux unavailable): today's flow,
   unchanged — resolve `claude`, build `RELAY_ARGS`, inject the SessionStart
   session-id hook via `--settings`, run `expect` to auto-answer the
   trust/dev-channel prompts, then `interact`.

Why this nesting: expect talks straight to Claude's pty exactly as it does
today (no matching through tmux client redraws), `interact` hands the pane to
the user, and Claude inherits `TMUX_PANE` so the port file self-records.

## Behavior rules

- `/new` semantics = always a **fresh** session; never attach-or-reuse
  (equivalent to `CLAUDE_CODE_TMUX_FRESH=1`). The plan/attach logic in
  `launch.sh` is NOT reused — only naming + orphan-kill.
- Opt-out: `CLAUDE_CODE_NO_TMUX=1` skips wrapping (same env var as the alias
  path).
- Already inside tmux (`$TMUX` set): no double-wrap; go straight to inner.
- tmux not installed: silent fallback to current behavior — nothing regresses
  on machines without tmux.
- The tmux session command must survive dirs with spaces/quotes (printf %q).
- Temp-file hygiene: the outer phase creates no temp files before its `exec`;
  the inner phase keeps the existing EXIT-trap cleanup.

## Testing

- Unit (bun test driving bash): outer-phase dispatch — asserts the exact tmux
  argv (socket, conf, session name shape, inner marker) via a PATH-shimmed
  fake `tmux`; fallback cases: tmux missing, `$TMUX` set, `CLAUDE_CODE_NO_TMUX=1`;
  adversarial: dir with spaces, dir with single quotes.
- E2E (verify skill): run the real script against a scratch dir with the real
  claude; assert the tmux session appears on `-L claude`, the pane runs
  claude, the relay port file gains `tmuxPane`/`tmuxSocket`, and
  `tmux send-keys` reaches the session. Then kill the session.

## Out of scope

- Ralph loops stay on plain cmux (stop/watchdog semantics would change).
- Headless paths (`--print`, relay-only) — nothing to wrap.
- Any bot-side TypeScript changes.
