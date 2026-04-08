#!/usr/bin/env bash
# Auto-answer Claude Code startup menus (workspace trust, then dev-channels) so
# /new works when nobody is at the Mac (Telegram remote). Requires /usr/bin/expect (macOS).
#
# Usage (from repo root):
#   DESKTOP_CLAUDE_COMMAND='/abs/path/to/claude-mobile-bridge/scripts/claude-relay-launch.sh {dir}'
#
# Optional: CLAUDE=/path/to/claude if not on PATH when Terminal starts.

set -euo pipefail

if [[ "${1:-}" == "" ]]; then
  echo "usage: claude-relay-launch.sh <project-directory>" >&2
  exit 1
fi

DIR="$1"
if [[ ! -d "$DIR" ]]; then
  echo "claude-relay-launch: not a directory: $DIR" >&2
  exit 1
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

RELAY_ARGS="${CLAUDE_RELAY_ARGS:---channels server:channel-relay --dangerously-load-development-channels server:channel-relay}"

QUOTE_DIR=$(printf %q "$DIR")
QUOTE_BIN=$(printf %q "$CLAUDE_BIN")
# shellcheck disable=SC2086
SPAWNCMD="cd ${QUOTE_DIR} && exec ${QUOTE_BIN} ${RELAY_ARGS}"
export SPAWNCMD

if [[ ! -x /usr/bin/expect ]]; then
  echo "claude-relay-launch: /usr/bin/expect not found (install expect)" >&2
  exit 1
fi

# Write the expect script to a temp file so that expect's stdin remains the
# real terminal pty (not the heredoc). This lets `interact` hand control back
# to the user after startup prompts are answered, keeping the terminal usable.
EXPECT_SCRIPT=$(mktemp /tmp/claude-relay-XXXXXX.exp)
trap 'rm -f "$EXPECT_SCRIPT"' EXIT

cat > "$EXPECT_SCRIPT" <<'EXPECT'
# Claude prints ANSI; match stable substrings. Trust prompt appears first when the
# workspace is new to this machine; dev-channels prompt follows when using --dangerously-load-development-channels.
set timeout 180
log_user 1
spawn bash -lc $env(SPAWNCMD)
# Set pty dimensions so Claude Code's Ink TUI renders properly.
# Without this, spawn inherits a 0x0 pty and the UI may not draw at all.
stty rows 50 cols 200
expect {
  -re {(?i)trust this folder|safety check|project you created} {
    sleep 0.5
    send "\r"
    sleep 1
    exp_continue
  }
  -re {(?i)local development|loading development channels|dangerously-load-development-channels} {
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

exec /usr/bin/expect "$EXPECT_SCRIPT"
