#!/bin/bash
# GitHub-free ralph loop: drains plans/tasks.md instead of `gh issue list`.
# Set RALPH_SCRIPT=/abs/scripts/ralph/afk_tasks_md.sh to use it. Reuses the
# vendored loop's tmpfile/signal/watchdog/`script` machinery verbatim so the
# bot's watchdog, verbose streaming, and `/ralph stop` keep working.

PR_MODE=false
ITERATIONS=""
# LABEL parsed and ignored (GitHub-issue concept; no gh here).
while [[ $# -gt 0 ]]; do
  case "$1" in
    -pr|--pr) PR_MODE=true; shift ;;
    -l|--label) shift 2 ;;
    *) ITERATIONS="$1"; shift ;;
  esac
done

if [ -z "$ITERATIONS" ]; then
  echo "Usage: $0 [-pr] [-l <label>] <iterations>"
  exit 1
fi
if [ "$PR_MODE" = true ]; then
  echo "note: -pr needs gh and is ignored here — direct-merge only."
fi

TASKS_FILE="plans/tasks.md"
if [ ! -f "$TASKS_FILE" ]; then
  echo "No $TASKS_FILE in $(pwd) — nothing to do."
  exit 1
fi

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
MB_ROOT="$(cd "$SELF_DIR/../.." && pwd)"
CLI="$MB_ROOT/src/ralph/tasks-queue-cli.ts"

PROMPT_FILE="${RALPH_PROMPT:-$SELF_DIR/prompt_tasks_md.md}"
if [ -f "plans/prompt_tasks.md" ]; then
  PROMPT_FILE="plans/prompt_tasks.md"
fi

# Empty = detached HEAD. Don't fall back to `rev-parse --abbrev-ref`, which
# yields the literal "HEAD": each session is told to merge into BASE BRANCH, and
# "merge into HEAD" is not a thing. Fail before burning an iteration.
BASE_BRANCH="$(git branch --show-current)"
if [ -z "$BASE_BRANCH" ]; then
  echo "Detached HEAD in $(pwd) — each task merges into the branch the loop started on. Check out a named branch first."
  exit 1
fi

# `script` argv is not portable: BSD/macOS is `script -q FILE CMD...`, while
# util-linux wants `script -q -c "CMD" FILE` and errors out on the BSD form.
# Production is macOS (the bot drives Terminal.app), but CI is Linux — without
# this branch the session simply never runs there. `%q` quotes each argument for
# the re-parse `-c` performs; $CONTEXT is multi-line and unsanitised.
run_claude_session() {
  if script --version 2>/dev/null | grep -qi util-linux; then
    script -q -c "$(printf '%q ' claude --dangerously-skip-permissions "$CONTEXT")" "$tmpfile"
  else
    script -q "$tmpfile" claude --dangerously-skip-permissions "$CONTEXT"
  fi
}

# --- session-control helpers (parent owns termination) — mirror afk_tasks.sh ---
pids_of_tree() { local p=$1 c; [ -z "$p" ] && return; echo "$p"; for c in $(pgrep -P "$p" 2>/dev/null); do pids_of_tree "$c"; done; }
kill_session() { local tree; tree=$(pids_of_tree "$(pgrep -f "$1" 2>/dev/null | head -1)"); [ -n "$tree" ] && { kill -TERM $tree 2>/dev/null; sleep 2; kill -KILL $tree 2>/dev/null; }; }
cleanup() { [ -n "$watchdog" ] && kill "$watchdog" 2>/dev/null; [ -n "$tmpfile" ] && kill_session "$tmpfile"; rm -f "$tmpfile" "$signalfile" 2>/dev/null; }
trap cleanup EXIT INT TERM

for ((i=1; i<=$ITERATIONS; i++)); do
  echo "=== Iteration $i/$ITERATIONS ==="

  q=$(bun "$CLI" next "$TASKS_FILE")
  status=$(echo "$q" | jq -r .status)

  if [ "$status" = "complete" ]; then
    echo "All issues resolved after $i iterations."
    exit 0
  fi
  if [ "$status" = "malformed" ]; then
    echo "Malformed $TASKS_FILE: $(echo "$q" | jq -r .error). Fix the file and re-run. Exiting."
    exit 1
  fi
  if [ "$status" = "waiting" ]; then
    echo "Queue blocked: items remain in $TASKS_FILE but none are eligible (check 'Depends on:' for a cycle or an unknown id). Exiting."
    exit 1
  fi

  id=$(echo "$q" | jq -r .id)
  block=$(echo "$q" | jq -r .block)

  CONTEXT="$block

BASE BRANCH: $BASE_BRANCH

@$PROMPT_FILE"

  tmpfile=$(mktemp)
  signalfile=$(mktemp); rm -f "$signalfile"
  export RALPH_SIGNAL="$signalfile"
  TIMEOUT=${RALPH_TIMEOUT:-1800}

  # Background watchdog: the PARENT owns termination (identical to afk_tasks.sh).
  (
    for n in $(seq 1 100); do pgrep -f "$tmpfile" >/dev/null 2>&1 && break; sleep 0.1; done
    waited=0
    while [ ! -f "$signalfile" ] && [ "$waited" -lt "$TIMEOUT" ]; do
      pgrep -f "$tmpfile" >/dev/null 2>&1 || exit 0
      sleep 1; waited=$((waited+1))
    done
    [ "$waited" -ge "$TIMEOUT" ] && echo "Timeout after ${TIMEOUT}s — killing session"
    sleep 1
    kill_session "$tmpfile"
  ) &
  watchdog=$!

  run_claude_session || true

  kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null

  signal=$(cat "$signalfile" 2>/dev/null)
  rm -f "$tmpfile" "$signalfile"

  if [ "$signal" = "COMPLETE" ]; then
    echo "All issues resolved after $i iterations."
    exit 0
  fi
  if [ "$signal" = "WAITING" ]; then
    echo "Waiting for other agents to complete blocking tasks..."
    sleep 5
    continue
  fi
  if [ "$signal" = "DONE" ]; then
    # A failed flip means the next iteration re-serves this same task forever.
    if ! bun "$CLI" done "$TASKS_FILE" "$id"; then
      echo "Could not mark task $id done in $TASKS_FILE — exiting rather than re-running it."
      exit 1
    fi
    git add "$TASKS_FILE" 2>/dev/null
    git commit -m "chore(ralph): mark task $id done" 2>/dev/null || true
  fi
  # Empty/other signal (timeout, crash): don't mark done — retry next iteration.
done

echo "Reached max iterations ($ITERATIONS)"
