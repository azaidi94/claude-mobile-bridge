#!/bin/bash
# Symlink ./hooks/* into ~/.claude/hooks/ so Claude Code picks them up.
# Symlinks (not copies) so edits in the checkout apply immediately.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${HOME}/.claude/hooks"

mkdir -p "$TARGET"

for src in "$REPO_ROOT/hooks/"*; do
  name="$(basename "$src")"
  ln -sfn "$src" "$TARGET/$name"
  chmod +x "$src"
  echo "linked: $TARGET/$name → $src"
done

cat <<'EOF'

Done.

To activate the AUQ remote bridge:
  1. Ensure RELAY_AUQ_SECRET is set in .env AND exported in your shell profile.
  2. Add the PreToolUse hook entry to ~/.claude/settings.json (see README).
  3. Restart the bot.

To activate exact /clear follow for sessions sharing a directory:
  1. Add the SessionStart hook entry to ~/.claude/settings.json (see README).
     (Sessions launched via claude-relay-launch.sh get it auto-injected.)
  2. Restart your Claude sessions so they load the hook (no hot-reload).
EOF
