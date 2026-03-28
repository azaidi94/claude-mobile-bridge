#!/usr/bin/env bash
# PreToolUse hook — bridges permission prompts to Telegram bot.
#
# Fast path: if bot is not watching this session, exits immediately.
# Otherwise writes a request file and polls for a response.

set -euo pipefail

PERM_DIR="/tmp/claude-permissions"
TIMEOUT_S=120
POLL_MS=0.3

# Read stdin
INPUT="$(cat)"

# Compute dirHash of cwd (SHA-256, first 12 hex chars)
DIR_HASH=$(echo -n "$PWD" | shasum -a 256 | cut -c1-12)

# Fast path: bot not watching → exit immediately
SIGNAL_FILE="${PERM_DIR}/watch-${DIR_HASH}"
if [ ! -f "$SIGNAL_FILE" ]; then
  exit 0
fi

# Extract tool info
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')

# Build description
case "$TOOL_NAME" in
  Bash)
    CMD=$(echo "$TOOL_INPUT" | jq -r '.command // empty')
    CMD="${CMD:0:200}"
    DESC=$(echo "$TOOL_INPUT" | jq -r '.description // empty')
    if [ -n "$DESC" ]; then
      DESCRIPTION="Bash: ${DESC}"
    else
      DESCRIPTION="Bash: ${CMD}"
    fi
    ;;
  Write|Edit)
    FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty')
    DESCRIPTION="${TOOL_NAME}: ${FILE_PATH}"
    ;;
  *)
    DESCRIPTION="$TOOL_NAME"
    ;;
esac

# Generate unique ID
ID="${DIR_HASH}-$(date +%s)-$(head -c 4 /dev/urandom | xxd -p)"
REQ_FILE="${PERM_DIR}/${ID}.req"
RES_FILE="${PERM_DIR}/${ID}.res"

# Write request (use jq to safely escape strings)
mkdir -p "$PERM_DIR"
jq -n --arg id "$ID" --arg tool "$TOOL_NAME" --arg desc "$DESCRIPTION" \
      --arg cwd "$PWD" --argjson ts "$(date +%s000)" \
      '{id:$id, tool_name:$tool, description:$desc, cwd:$cwd, timestamp:$ts}' \
      > "$REQ_FILE"

# Poll for response
DEADLINE=$((SECONDS + TIMEOUT_S))
while [ $SECONDS -lt $DEADLINE ]; do
  if [ -f "$RES_FILE" ]; then
    RESPONSE=$(cat "$RES_FILE")
    rm -f "$REQ_FILE" "$RES_FILE" 2>/dev/null
    echo "$RESPONSE"
    exit 0
  fi
  sleep "$POLL_MS"
done

# Timeout — clean up and deny
rm -f "$REQ_FILE" 2>/dev/null
echo '{"decision":"deny","reason":"Permission timeout"}'
exit 0
