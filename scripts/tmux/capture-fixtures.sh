#!/usr/bin/env bash
# Capture a LIVE Claude Code pane into a test fixture.
#
# Fixtures must be captured, never hand-authored: a written fixture encodes our
# belief about how a dialog renders, so the guard's tests would pass while the
# guard still let Enter through on the real dialog.
#
#   usage: scripts/tmux/capture-fixtures.sh <fixture-name> [pane-id]
set -euo pipefail

name="${1:?usage: capture-fixtures.sh <fixture-name> [pane-id]}"
pane="${2:-}"
dir="src/__tests__/fixtures/tmux-panes"
mkdir -p "$dir"

if [[ -z "$pane" ]]; then
  pane="$(tmux -L claude list-panes -a -F '#{pane_id}' | head -1)"
  echo "no pane given; using first: $pane" >&2
fi

tmux -L claude capture-pane -p -t "$pane" >"$dir/$name.txt"
echo "captured $dir/$name.txt ($(wc -l <"$dir/$name.txt" | tr -d ' ') lines)"
