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

TOOL=$(printf '%s' "$INPUT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_name",""))' 2>/dev/null || true)

if [ "$TOOL" != "AskUserQuestion" ]; then
  emit_allow
  exit 0
fi

LOG_DIR="${HOME}/.claude/logs"
mkdir -p "$LOG_DIR"

# Make every AUQ hook invocation visible so silent bails (missing secret, no
# tmux pane) can be told apart from successful worker spawns. Without this, a
# session that never bridges looks identical to one that does. Guarded so the
# logging never aborts the hook itself.
log_hook() {
  {
    local cwd
    cwd=$(printf '%s' "$INPUT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("cwd",""))' 2>/dev/null || true)
    printf 'auq-bridge-hook: %s secret=%s tmux=%s cwd=%s\n' \
      "$1" "${RELAY_AUQ_SECRET:+set}" "${TMUX_PANE:+set}" "$cwd" \
      >> "$LOG_DIR/auq-bridge-worker.log"
  } 2>/dev/null || true
}

if [ -z "${RELAY_AUQ_SECRET:-}" ]; then
  log_hook "bailed: no RELAY_AUQ_SECRET"
  emit_allow
  exit 0
fi

log_hook "spawning worker"
WORKER="${HOME}/.claude/hooks/claude-remote-auq-worker.ts"
TMUX_PANE="${TMUX_PANE:-}"

REQUEST_ID="auq_$(uuidgen 2>/dev/null || python3 -c 'import uuid;print(uuid.uuid4().hex)')"
WORKER_INPUT=$(printf '%s' "$INPUT" | REQUEST_ID="$REQUEST_ID" TMUX_PANE="$TMUX_PANE" python3 -c '
import json, sys, os
d = json.load(sys.stdin)
d["request_id"] = os.environ["REQUEST_ID"]
d["tmux_pane"] = os.environ.get("TMUX_PANE", "")
print(json.dumps(d))
')

(
  nohup bun run "$WORKER" <<<"$WORKER_INPUT" \
    >>"$LOG_DIR/auq-bridge-worker.log" 2>&1 &
) &
disown 2>/dev/null || true

emit_allow
exit 0
