#!/usr/bin/env bash
# Install the permission-bridge hook into ~/.claude/settings.json
# Usage: ./scripts/install-hook.sh

set -euo pipefail

SETTINGS="$HOME/.claude/settings.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_PATH="${SCRIPT_DIR}/permission-bridge.sh"

if [ ! -f "$HOOK_PATH" ]; then
  echo "Error: permission-bridge.sh not found at $HOOK_PATH"
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install with: brew install jq"
  exit 1
fi

if [ ! -f "$SETTINGS" ]; then
  echo "Error: $SETTINGS not found"
  exit 1
fi

# Check if already installed
if jq -e '.hooks.PreToolUse[]? | select(.hooks[]?.command | contains("permission-bridge"))' "$SETTINGS" &>/dev/null; then
  echo "Permission bridge hook is already installed."
  exit 0
fi

# Add the hook to PreToolUse array
UPDATED=$(jq --arg cmd "$HOOK_PATH" '.hooks.PreToolUse += [{
  "matcher": "",
  "hooks": [{
    "type": "command",
    "command": $cmd,
    "timeout": 125
  }]
}]' "$SETTINGS")

echo "$UPDATED" > "$SETTINGS"
echo "✅ Permission bridge hook installed."
echo "   Hook: $HOOK_PATH"
echo "   Settings: $SETTINGS"
