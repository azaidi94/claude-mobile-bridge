#!/bin/bash
# Usage: ralph-runner.sh <run-dir> <repo-path> [afk_tasks.sh args...]
#
# Thin wrapper the desktop terminal runs. Writes meta.json (so the bot learns
# the wrapper pid — it never spawns this directly), runs the ralph loop under an
# outer `script -q -F` (preserves the pty chain the inner `script … claude`
# needs AND mirrors output to run.log for the bot to tail), then writes the
# exit code as the completion signal.
set -u
RUN_DIR="$1"; REPO="$2"; shift 2
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
RALPH="${RALPH_SCRIPT:-$SELF_DIR/ralph/afk_tasks.sh}"
mkdir -p "$RUN_DIR"
cd "$REPO" || { echo "ralph-runner: cannot cd $REPO"; exit 1; }
printf '{"pid":%d,"startedAt":"%s"}\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RUN_DIR/meta.json"
script -q -F "$RUN_DIR/run.log" "$RALPH" "$@"
code=$?
echo "$code" > "$RUN_DIR/exit"
echo "=== ralph loop finished (exit $code) ==="
exit $code
