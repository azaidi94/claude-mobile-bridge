#!/bin/bash

PR_MODE=false
ITERATIONS=""
LABEL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -pr|--pr) PR_MODE=true; shift ;;
    -l|--label) LABEL="$2"; shift 2 ;;
    *) ITERATIONS="$1"; shift ;;
  esac
done

if [ -z "$ITERATIONS" ]; then
  echo "Usage: $0 [-pr] [-l|--label <label>] <iterations>"
  exit 1
fi

LABEL_FLAG=""
if [ -n "$LABEL" ]; then
  LABEL_FLAG="--label $LABEL"
fi

REPO_NAME=$(basename $PWD)
export CLAUDE_CODE_TASK_LIST_ID="ralph-$REPO_NAME"

PROMPT_FILE="${RALPH_PROMPT:-$(cd "$(dirname "$0")" && pwd)/prompt_tasks.md}"
if [ -f "plans/prompt_tasks.md" ]; then
  PROMPT_FILE="plans/prompt_tasks.md"
fi

TASK_DIR="$HOME/.claude/tasks/ralph-$REPO_NAME"

# --- session-control helpers (parent owns termination) ---
# Snapshot a process subtree (root + all descendants), one pid per line.
pids_of_tree() { local p=$1 c; [ -z "$p" ] && return; echo "$p"; for c in $(pgrep -P "$p" 2>/dev/null); do pids_of_tree "$c"; done; }
# Kill the `script` process whose argv contains the given (unique) path, plus all its descendants.
kill_session() { local tree; tree=$(pids_of_tree "$(pgrep -f "$1" 2>/dev/null | head -1)"); [ -n "$tree" ] && { kill -TERM $tree 2>/dev/null; sleep 2; kill -KILL $tree 2>/dev/null; }; }
# Backstop cleanup on interrupt/exit so we never orphan a claude session or temp files.
cleanup() { [ -n "$watchdog" ] && kill "$watchdog" 2>/dev/null; [ -n "$tmpfile" ] && kill_session "$tmpfile"; rm -f "$tmpfile" "$signalfile" 2>/dev/null; }
trap cleanup EXIT INT TERM

for ((i=1; i<=$ITERATIONS; i++)); do
  echo "=== Iteration $i/$ITERATIONS ==="

  # Two-phase fetch: full on first run (for task creation), slim on subsequent
  if [ -d "$TASK_DIR" ] && [ "$(ls -A "$TASK_DIR" 2>/dev/null)" ]; then
    echo "Tasks exist - slim fetch (number, title only)"
    issues=$(gh issue list --state open $LABEL_FLAG --json number,title)
  else
    echo "First run - full fetch (with body, comments)"
    issues=$(gh issue list --state open $LABEL_FLAG --json number,title,body,comments)
  fi

  # Check if any open issues
  issue_count=$(echo "$issues" | jq 'length')
  if [ "$issue_count" -eq 0 ]; then
    echo "No open issues. All done!"
    rm -rf "$TASK_DIR"
    exit 0
  fi

  recent_commits=$(git log --oneline -10 2>/dev/null || echo "No commits yet")

  # Include commits from issue branches (pattern: <number>-<slug>) — only for OPEN
  # issues and capped, so stale/closed-issue branches don't flood the context.
  open_nums=$(echo "$issues" | jq -r '.[].number' 2>/dev/null)
  ralph_branches=$(git branch --list '[0-9]*-*' 2>/dev/null | sed 's/^[* ]*//')
  if [ -n "$ralph_branches" ]; then
    for branch in $ralph_branches; do
      bn=$(echo "$branch" | grep -oE '^[0-9]+')
      echo "$open_nums" | grep -qx "$bn" || continue   # skip closed/unknown issues
      commits=$(git log --oneline -8 main..$branch 2>/dev/null)
      if [ -n "$commits" ]; then
        recent_commits="$recent_commits

[$branch]
$commits"
      fi
    done
  fi

  # PR mode: also include open PR branches
  if [ "$PR_MODE" = true ]; then
    pr_branches=$(gh pr list --author @me --state open --json headRefName -q '.[].headRefName' 2>/dev/null)
    if [ -n "$pr_branches" ]; then
      for branch in $pr_branches; do
        # Skip if already included as ralph branch
        echo "$ralph_branches" | grep -q "^$branch$" && continue
        commits=$(git log --oneline -8 main..$branch 2>/dev/null)
        if [ -n "$commits" ]; then
          recent_commits="$recent_commits

[$branch]
$commits"
        fi
      done
    fi
  fi

  if [ "$PR_MODE" = true ]; then
    MODE="pr"
  else
    MODE="direct"
  fi

  CONTEXT="$issues

RECENT COMMITS:
$recent_commits

MODE: $MODE

@$PROMPT_FILE"

  tmpfile=$(mktemp)
  signalfile=$(mktemp); rm -f "$signalfile"
  export RALPH_SIGNAL="$signalfile"
  TIMEOUT=${RALPH_TIMEOUT:-1800}

  # Background watchdog: the PARENT owns termination, not the model.
  # macOS `script` must run in the foreground on a real tty, so we can't capture its
  # pid via `&`/$!. The watchdog instead finds it by the unique tmpfile path, waits for
  # the model's signal file (or a timeout), then kills `script` + everything under it.
  (
    for n in $(seq 1 100); do pgrep -f "$tmpfile" >/dev/null 2>&1 && break; sleep 0.1; done  # wait for script to appear
    waited=0
    while [ ! -f "$signalfile" ] && [ "$waited" -lt "$TIMEOUT" ]; do
      pgrep -f "$tmpfile" >/dev/null 2>&1 || exit 0   # claude exited on its own
      sleep 1; waited=$((waited+1))
    done
    [ "$waited" -ge "$TIMEOUT" ] && echo "Timeout after ${TIMEOUT}s — killing session"
    sleep 1                                           # let final output flush
    kill_session "$tmpfile"
  ) &
  watchdog=$!

  # Foreground, attached to the real terminal (macOS `script` requires a real tty here).
  script -q "$tmpfile" claude --dangerously-skip-permissions "$CONTEXT" || true

  kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null

  signal=$(cat "$signalfile" 2>/dev/null)
  rm -f "$tmpfile" "$signalfile"

  # COMPLETE = all issues done; WAITING = blocked; DONE/empty = next iteration
  if [ "$signal" = "COMPLETE" ]; then
    echo "All issues resolved after $i iterations."
    rm -rf "$TASK_DIR"
    exit 0
  fi
  if [ "$signal" = "WAITING" ]; then
    echo "Waiting for other agents to complete blocking tasks..."
    sleep 5
  fi
done

echo "Reached max iterations ($ITERATIONS)"
