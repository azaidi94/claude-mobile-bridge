#!/usr/bin/env bash
# Auto-answer Claude Code startup menus (workspace trust, then dev-channels) so
# /new works when nobody is at the Mac (Telegram remote). Requires /usr/bin/expect (macOS).
#
# Usage (from repo root):
#   DESKTOP_CLAUDE_COMMAND='/abs/path/to/claude-mobile-bridge/scripts/claude-relay-launch.sh {dir}'
#
# Optional: CLAUDE=/path/to/claude if not on PATH when Terminal starts.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$HERE/claude-relay-launch.sh"

# ── tmux outer phase ────────────────────────────────────────────────────
# /new spawns must run Claude under `tmux -L claude` so the relay port file
# records tmuxPane/tmuxSocket and the bot can inject /clear //compact via
# `tmux send-keys` (spec: docs/superpowers/specs/2026-08-02-new-spawn-tmux-design.md).
# Nesting is tmux OUTSIDE, expect INSIDE: the pane runs this script's inner
# phase, so expect talks straight to Claude's pty exactly as before and
# `interact` hands the pane to the user.

# Wrap unless: opted out, already inside tmux, already the inner phase, or
# tmux isn't installed (silent fallback — nothing regresses without tmux).
_crl_should_wrap() {
  [ "${CLAUDE_CODE_NO_TMUX:-}" != 1 ] \
    && [ -z "${TMUX:-}" ] \
    && [ "${CC_RELAY_INNER:-}" != 1 ] \
    && command -v tmux > /dev/null 2>&1
}

# Exec seam — overridden in tests to capture argv (same pattern as launch.sh).
_crl_do_exec() { exec "$@"; }

# Re-exec this script inside a fresh tmux session on the dedicated socket.
# /new means NEW: always create (never attach-or-reuse) — only the naming and
# stale-orphan kill are reused from launch.sh, not its hybrid planner. Never
# returns in prod. Creates no temp files (the EXIT-trap hygiene below belongs
# entirely to the inner phase).
_crl_exec_outer() {
  local dir="$1" name envs="" v
  # shellcheck disable=SC1091
  source "$HERE/tmux/launch.sh" # _cc_launch_name, CC_TMUX_SOCKET, CC_TMUX_CONF
  name=$(_cc_launch_name "$dir" "$$")
  # A session already holding this exact name is presumed a stale orphan from
  # a past process that had our pid (sessions outlive their launcher pid by
  # design — the launcher execs into the tmux CLIENT). Kill it or new-session
  # fails "duplicate". The `=` sigil forces EXACT-name matching: tmux
  # prefix-matches bare targets, so without it `…-123` would kill a live
  # sibling named `…-1234`.
  tmux -L "$CC_TMUX_SOCKET" kill-session -t "=$name" 2> /dev/null || true
  # Forward per-spawn env INSIDE the command string: with a pre-existing tmux
  # server (the common case — the ccd alias keeps one alive), new-session
  # commands run in the SERVER's env, which silently drops these.
  for v in CLAUDE CLAUDE_CLI_PATH CLAUDE_RELAY_ARGS CRL_EXPECT_TIMEOUT; do
    if [ -n "${!v:-}" ]; then
      envs+="$v=$(printf %q "${!v}") "
    fi
  done
  _crl_do_exec tmux -L "$CC_TMUX_SOCKET" -f "$CC_TMUX_CONF" new-session -s "$name" \
    "CC_RELAY_INNER=1 ${envs}$(printf %q "$SELF") $(printf %q "$dir")"
}

# Test mode: definitions only, no main (see claude-relay-launch.test.sh).
if [ "${CRL_TEST:-}" = 1 ]; then return 0 2> /dev/null || exit 0; fi

if [[ "${1:-}" == "" ]]; then
  echo "usage: claude-relay-launch.sh <project-directory>" >&2
  exit 1
fi

DIR="$1"
if [[ ! -d "$DIR" ]]; then
  echo "claude-relay-launch: not a directory: $DIR" >&2
  exit 1
fi

if _crl_should_wrap; then
  _crl_exec_outer "$DIR"
fi

CLAUDE_BIN="${CLAUDE:-}"
if [[ -z "$CLAUDE_BIN" && -n "${CLAUDE_CLI_PATH:-}" ]]; then
  CLAUDE_BIN="$CLAUDE_CLI_PATH"
fi
if [[ -z "$CLAUDE_BIN" ]]; then
  CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
fi
if [[ -z "$CLAUDE_BIN" || ! -x "$CLAUDE_BIN" ]]; then
  echo "claude-relay-launch: set CLAUDE or CLAUDE_CLI_PATH to a runnable claude binary" >&2
  exit 1
fi

#   NB: do NOT pass `--channels server:channel-relay` — that adds the entry
#   to the *regular* approved-channels list (which requires prior allowlist
#   approval), producing a "not on the approved channels allowlist" warning
#   AND listing the channel twice in the UI. `--dangerously-load-development-channels`
#   alone is sufficient to both approve and listen on the channel.
RELAY_ARGS="${CLAUDE_RELAY_ARGS:---dangerously-skip-permissions --dangerously-load-development-channels server:channel-relay}"

# Single EXIT cleanup for both temp files (the --settings fragment below + the
# expect script created later). Registered BEFORE the fragment mktemp so an
# early exit can't leak it, and each rm is guarded so an unset/empty var never
# becomes `rm -f ""`. EXPECT_SCRIPT is read lazily at EXIT (set further down).
SETTINGS_FRAGMENT=""
cleanup_tmp() {
  [[ -n "${EXPECT_SCRIPT:-}" ]] && rm -f "$EXPECT_SCRIPT"
  [[ -n "${SETTINGS_FRAGMENT:-}" ]] && rm -f "$SETTINGS_FRAGMENT"
  return 0
}
trap cleanup_tmp EXIT

# Auto-inject the SessionStart session-id hook so remote-/new sessions get exact
# /clear follow (when sharing a dir) without a manual settings.json edit. The
# hook writes each Claude process's live session_id into its own relay port file.
# `--settings` LOADS ADDITIONAL settings (it MERGES — confirmed via `claude
# --help`: "load additional settings from"), so this only ADDS the hook and
# never replaces the user's settings. Skipped silently if the hook isn't
# installed (run `bun run install-hooks`).
SETTINGS_ARG=""
SESSION_ID_HOOK="${HOME}/.claude/hooks/claude-remote-session-id.ts"
if [[ -x "$SESSION_ID_HOOK" ]]; then
  SETTINGS_FRAGMENT=$(mktemp /tmp/claude-relay-settings-XXXXXX)
  printf '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"%s"}]}]}}' \
    "$SESSION_ID_HOOK" > "$SETTINGS_FRAGMENT"
  SETTINGS_ARG="--settings $(printf %q "$SETTINGS_FRAGMENT")"
fi

QUOTE_DIR=$(printf %q "$DIR")
QUOTE_BIN=$(printf %q "$CLAUDE_BIN")
# shellcheck disable=SC2086
SPAWNCMD="cd ${QUOTE_DIR} && exec ${QUOTE_BIN} ${RELAY_ARGS} ${SETTINGS_ARG}"
export SPAWNCMD

if [[ ! -x /usr/bin/expect ]]; then
  echo "claude-relay-launch: /usr/bin/expect not found (install expect)" >&2
  exit 1
fi

# Write the expect script to a temp file so that expect's stdin remains the
# real terminal pty (not the heredoc). This lets `interact` hand control back
# to the user after startup prompts are answered, keeping the terminal usable.
# NB: BSD mktemp (macOS) only substitutes the X's when they're at the very
# end of the template — a `.exp` suffix makes mktemp create a literal
# `XXXXXX.exp` file, which collides on the second run. Keep X's at the end.
EXPECT_SCRIPT=$(mktemp /tmp/claude-relay-XXXXXX)
# Cleanup handled by the cleanup_tmp EXIT trap registered above.

cat > "$EXPECT_SCRIPT" <<'EXPECT'
# Claude prints ANSI; match stable substrings. Trust prompt appears first when the
# workspace is new to this machine; dev-channels prompt follows when using --dangerously-load-development-channels.
#
# NB: Ink renders with cursor-column escapes BETWEEN WORDS
# ("Quick\e[8Gsafety\e[15Gcheck:"), so multi-word phrases never appear
# contiguously in the raw byte stream expect matches against. Multi-word
# patterns join words with $SEP (defined below) — escape-sequence-aware,
# but immune to prose/cross-line false matches.
if {[info exists env(CRL_EXPECT_TIMEOUT)]
    && [string is integer -strict $env(CRL_EXPECT_TIMEOUT)]} {
  set timeout $env(CRL_EXPECT_TIMEOUT)
} else {
  set timeout 180
}
log_user 1

# Word separator for prompt matching: Ink emits cursor-column escapes between
# words, so "safety check" arrives as "safety\x1b\[15Gcheck". SEP admits full
# CSI sequences and non-letter runs (spaces, punctuation) but NOT bare letters
# or newlines — so prose like "safety first, always check" or a phrase split
# across lines can never false-match and answer a menu early.
set SEP {(?:\x1b\[[0-9;]*[A-Za-z]|[^A-Za-z\r\n]){0,24}?}
spawn bash -lc $env(SPAWNCMD)
# Set pty dimensions so Claude Code's Ink TUI renders properly.
# Without this, spawn inherits a 0x0 pty and the UI may not draw at all.
stty rows 50 cols 200
expect {
  -re "(?i)trust${SEP}this${SEP}folder|safety${SEP}check|project${SEP}you${SEP}created" {
    sleep 0.5
    send "\r"
    sleep 1
    exp_continue
  }
  -re "(?i)local${SEP}development|loading${SEP}development${SEP}channels|dangerously-load-development-channels" {
    sleep 0.5
    send "\r"
    # Hand control back to the terminal so the user can interact with Claude.
    interact
    exit 0
  }
  eof {
    exit 0
  }
  timeout {
    puts stderr "claude-relay-launch: timed out waiting for trust/dev-channel menus (Claude UI changed?)"
    exit 1
  }
}
EXPECT

# Don't `exec` expect — that replaces this shell and the EXIT trap never
# fires, leaving stale temp files in /tmp until the next reboot.
/usr/bin/expect "$EXPECT_SCRIPT"
