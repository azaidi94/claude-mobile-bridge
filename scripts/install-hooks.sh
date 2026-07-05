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

echo
echo "Registering hook entries in ~/.claude/settings.json …"
# Don't abort (set -e) if registration fails — the symlinks above are already in
# place; register-hooks prints its own remediation and can be re-run on its own.
bun run "$REPO_ROOT/scripts/register-hooks.ts" || \
  echo "register-hooks: registration failed (see above). Symlinks are in place; fix the issue and re-run 'bun run register-hooks'."

cat <<'EOF'

Done. Both hook entries are registered (idempotent — re-running is safe).

To activate the AUQ remote bridge (optional):
  1. Run 'bun run setup-auq-secret' — writes the shared secret to .env AND your
     shell profile (same value), then prints the 'source' command to reload it.
  2. Restart the bot.
  (Without the secret the PreToolUse hook just passes through to the local TUI.)

Exact /clear follow (SessionStart) is active once you restart your Claude
sessions so they load the hook (no hot-reload). The bot reloads on its own.
EOF
