#!/usr/bin/env bash
# scripts/tmux/launch.sh — attach-or-create tmux launcher for Claude Code.
# Sourced by ~/.bash_profile's _ccd_launch_claude. Guarantees at most one live
# Claude tmux session per working directory so the bridge's topic watcher isn't
# spammed with "new conversation" rebinds by sibling sessions.

CC_TMUX_SOCKET="claude"
CC_TMUX_CONF="$HOME/Projects/Cursor/AHZ/claude-mobile-bridge/scripts/claude-tmux.conf"

# 8-char hex hash of a string. macOS `md5 -q`, Linux `md5sum`.
_cc_hash8() {
  if command -v md5 >/dev/null 2>&1; then
    printf '%s' "$1" | md5 -q | cut -c1-8
  else
    printf '%s' "$1" | md5sum | cut -c1-8
  fi
}

# Deterministic, tmux-safe session name for a directory: cc-<base>-<hash8>.
# Full path is hashed so same-basename repos never collide.
_cc_session_name() {
  local dir="${1:-$PWD}" base
  base=$(basename "$dir" | tr -c 'A-Za-z0-9_' '-' | sed 's/--*/-/g; s/-$//')
  printf 'cc-%s-%s' "$base" "$(_cc_hash8 "$dir")"
}

# Decide the launch action. Pure — no IO. See interface notes in the plan.
_cc_decide() {
  local fresh="$1" nuser="$2" existing="$3"
  if [ "$fresh" = 1 ] || [ "$nuser" -gt 0 ]; then echo "fresh"; return; fi
  if [ "$existing" -gt 0 ]; then echo "attach"; else echo "new"; fi
}

# List live sessions whose pane cwd == dir. Output: "<attached>\t<name>" lines.
_cc_sessions_for_cwd() {
  local dir="${1:-$PWD}"
  tmux -L "$CC_TMUX_SOCKET" list-panes -a \
    -F '#{pane_current_path}	#{session_attached}	#{session_name}' 2>/dev/null \
    | awk -F'\t' -v d="$dir" '$1==d { print $2"\t"$3 }'
}

# Kill detached sessions for dir (orphans left by closed terminals). Opt out
# with CLAUDE_CODE_TMUX_NO_REAP=1. Attached sessions are never touched.
_cc_reap_detached() {
  local dir="${1:-$PWD}" attached name
  [ "${CLAUDE_CODE_TMUX_NO_REAP:-}" = 1 ] && return 0
  while IFS=$'\t' read -r attached name; do
    [ -z "$name" ] && continue
    if [ "$attached" = 0 ]; then
      tmux -L "$CC_TMUX_SOCKET" kill-session -t "$name" 2>/dev/null
    fi
  done < <(_cc_sessions_for_cwd "$dir")
}

# Pure launch planner. Prints one tab-separated line: the action and its
# operands. No exec, no reaping — see cc_tmux_launch for the side effects.
_cc_plan_launch() {
  local dir="$1" nuser="$2" pid="$3"; shift 3
  local fresh=0; [ "${CLAUDE_CODE_TMUX_FRESH:-0}" = 1 ] && fresh=1
  local sessions existing action name cmd target
  sessions=$(_cc_sessions_for_cwd "$dir")
  existing=$(printf '%s' "$sessions" | grep -c '[^[:space:]]')
  action=$(_cc_decide "$fresh" "$nuser" "$existing")
  printf -v cmd 'exec claude %s' "$(printf '%q ' "$@")"
  cmd=${cmd% }   # strip the trailing space printf %q leaves
  case "$action" in
    attach)
      target=$(printf '%s\n' "$sessions" | awk -F'\t' '$1==0 {print $2; exit}')
      [ -z "$target" ] && target=$(printf '%s\n' "$sessions" | awk -F'\t' 'NF{print $2; exit}')
      printf 'attach\t%s' "$target"
      ;;
    new)
      printf 'new\t%s\t%s' "$(_cc_session_name "$dir")" "$cmd"
      ;;
    fresh)
      printf 'fresh\t%s-%s\t%s' "$(_cc_session_name "$dir")" "$pid" "$cmd"
      ;;
  esac
}

# Exec seam — overridden in tests to capture argv instead of replacing the shell.
_cc_do_exec() { exec "$@"; }

# UUID generator (macOS uuidgen, lowercased to match Claude's session-id format).
_cc_uuid() {
  uuidgen | tr 'A-Z' 'a-z'
}

# True (0) unless the claude argv already selects/resumes a specific session,
# in which case pinning a fresh --session-id would conflict with that intent.
_cc_should_pin_id() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --session-id|--resume|-r|--continue|-c) return 1 ;;
    esac
  done
  return 0
}

# Entry point called by _ccd_launch_claude. $1 = number of user (non-flag) args;
# the rest is the full claude argv (flags + user args). Uses $PWD and $$.
cc_tmux_launch() {
  local nuser="$1"; shift
  local dir="$PWD" plan action rest name cmd target
  plan=$(_cc_plan_launch "$dir" "$nuser" "$$" "$@")
  action=${plan%%$'\t'*}
  rest=${plan#*$'\t'}
  case "$action" in
    attach)
      target="$rest"
      _cc_do_exec tmux -L "$CC_TMUX_SOCKET" attach-session -t "$target"
      ;;
    new)
      name=${rest%%$'\t'*}
      cmd=${rest#*$'\t'}
      if _cc_should_pin_id "$@"; then
        printf -v cmd 'exec claude --session-id %s %s' "$(_cc_uuid)" "$(printf '%q ' "$@")"
        cmd=${cmd% }
      fi
      _cc_do_exec tmux -L "$CC_TMUX_SOCKET" -f "$CC_TMUX_CONF" new-session -s "$name" "$cmd"
      ;;
    fresh)
      name=${rest%%$'\t'*}
      cmd=${rest#*$'\t'}
      _cc_reap_detached "$dir"
      if _cc_should_pin_id "$@"; then
        printf -v cmd 'exec claude --session-id %s %s' "$(_cc_uuid)" "$(printf '%q ' "$@")"
        cmd=${cmd% }
      fi
      _cc_do_exec tmux -L "$CC_TMUX_SOCKET" -f "$CC_TMUX_CONF" new-session -s "$name" "$cmd"
      ;;
  esac
}
