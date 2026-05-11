#!/bin/bash
# Claude Code PreToolUse hook — AskUserQuestion remote bridge.
# Reads tool-call JSON on stdin. For AskUserQuestion calls, spawns a detached
# worker that bridges the question to the mobile-bridge bot. For any other
# tool, exits with a passthrough "allow" verdict. Designed to finish in
# <100ms so CC's tool dispatch isn't blocked.

set -euo pipefail

INPUT="$(cat)"

emit_allow() {
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}
JSON
}

TOOL=$(printf '%s' "$INPUT" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)

if [ "$TOOL" != "AskUserQuestion" ]; then
  emit_allow
  exit 0
fi

if [ -z "${RELAY_AUQ_SECRET:-}" ]; then
  emit_allow
  exit 0
fi

# Pass the bearer secret via stdin to `curl -H @-` so it doesn't appear in
# the process list (ps aux would otherwise show the Authorization arg).
WEB_PORT="${WEB_PORT:-3000}"
printf 'Authorization: Bearer %s\n' "$RELAY_AUQ_SECRET" \
  | curl -s -o /dev/null -m 0.1 "http://localhost:${WEB_PORT}/api/auq-bridge/_ping" \
    -H @- || true

LOG_DIR="${HOME}/.claude/logs"
mkdir -p "$LOG_DIR"
WORKER="${HOME}/.claude/hooks/claude-remote-auq-worker.ts"
TMUX_PANE="${TMUX_PANE:-}"

REQUEST_ID="auq_$(uuidgen 2>/dev/null || python3 -c 'import uuid;print(uuid.uuid4().hex)')"
WORKER_INPUT=$(printf '%s' "$INPUT" | python3 -c '
import json, sys, os
d = json.load(sys.stdin)
d["request_id"] = os.environ["REQUEST_ID"]
d["tmux_pane"] = os.environ.get("TMUX_PANE", "")
print(json.dumps(d))
' REQUEST_ID="$REQUEST_ID" TMUX_PANE="$TMUX_PANE")

(
  nohup bun run "$WORKER" <<<"$WORKER_INPUT" \
    >>"$LOG_DIR/auq-bridge-worker.log" 2>&1 &
) &
disown 2>/dev/null || true

emit_allow
exit 0
