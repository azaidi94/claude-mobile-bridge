#!/usr/bin/env bash
# scripts/tmux/launch.sh — hybrid reattach-or-create tmux launcher for Claude Code.
# Sourced by ~/.bash_profile's _cct_launch_claude.
#
# Behavior (bare `cct`):
#   - a DETACHED session in this dir (your work, left running when you closed the
#     terminal) → ATTACH to it;
#   - sessions exist but are all ATTACHED (you're already viewing one elsewhere)
#     → CREATE a new sibling rather than mirror the same session into two windows;
#   - no session in this dir → CREATE.
# Passing claude args (`cct --resume`, a prompt, …) or CLAUDE_CODE_TMUX_FRESH=1
# forces CREATE — you're starting a fresh invocation, not reattaching.
#
# CCT_MODE (env, set in ~/.bash_profile) overrides the reuse policy:
#   hybrid (default) — attach to a detached session, else create a sibling.
#   attach           — always reuse one session per folder (2nd client if attached).
#   create           — always a fresh session (pure always-create).
#
# New sessions are named cc-<base>-<hash8>-<pid> so N can run in one folder; the
# bridge identifies each by its hook-minted launchUuid (P2/P3 registry), so we do
# NOT pin --session-id (a pinned id would freeze on /clear). claude argv is passed
# through verbatim. Keeps the dedicated `-L claude` socket + claude-tmux.conf.

CC_TMUX_SOCKET="claude"
# Resolve claude-tmux.conf relative to THIS script (scripts/tmux/launch.sh →
# ../claude-tmux.conf) so the launcher is portable across clones. Works when the
# file is sourced (BASH_SOURCE) or run. CC_TMUX_CONF can be pre-set to override.
if [ -z "${CC_TMUX_CONF:-}" ]; then
  _cc_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd 2>/dev/null)"
  CC_TMUX_CONF="${_cc_dir%/}/../claude-tmux.conf"
fi

# 8-char hex hash of a string. macOS `md5 -q`, Linux `md5sum`.
_cc_hash8() {
  if command -v md5 >/dev/null 2>&1; then
    printf '%s' "$1" | md5 -q | cut -c1-8
  else
    printf '%s' "$1" | md5sum | cut -c1-8
  fi
}

# Base session name for a directory: cc-<base>-<hash8>. Full path is hashed so
# same-basename repos never collide.
_cc_session_name() {
  local dir="${1:-$PWD}" base
  base=$(basename "$dir" | tr -c 'A-Za-z0-9_' '-' | sed 's/--*/-/g; s/-$//')
  printf 'cc-%s-%s' "$base" "$(_cc_hash8 "$dir")"
}

# Per-launch unique session name: cc-<base>-<hash8>-<pid>. The pid makes N
# sessions in one dir distinct tmux sessions (siblings coexist).
_cc_launch_name() {
  local dir="${1:-$PWD}" pid="${2:-$$}"
  printf '%s-%s' "$(_cc_session_name "$dir")" "$pid"
}

# List live sessions whose pane cwd == dir. Output: "<attached>\t<name>" lines
# (attached=0 means detached).
_cc_sessions_for_cwd() {
  local dir="${1:-$PWD}"
  tmux -L "$CC_TMUX_SOCKET" list-panes -a \
    -F '#{pane_current_path}	#{session_attached}	#{session_name}' 2>/dev/null \
    | awk -F'\t' -v d="$dir" '$1==d { print $2"\t"$3 }'
}

# Exec seam — overridden in tests to capture argv instead of replacing the shell.
_cc_do_exec() { exec "$@"; }

# Pure launch planner. Prints one tab-separated line:
#   attach\t<session-name>            — reattach to a detached session, OR
#   new\t<session-name>\t<claude-cmd> — create a fresh uniquely-named session.
# Hybrid: attach ONLY to a detached session; create otherwise (no existing, or
# all existing are attached). $2 = number of user (non-flag) claude args, >0 or
# CLAUDE_CODE_TMUX_FRESH=1 forces create. No exec — see cc_tmux_launch.
# CCT_MODE (env, default `hybrid`) picks the reuse policy:
#   hybrid — attach to a DETACHED session, else create a sibling (default).
#   attach — reuse ANY existing session (detached preferred, else attach as a
#            2nd client to an attached one); one session per folder.
#   create — never reuse; always a fresh session.
_cc_plan_launch() {
  local dir="$1" nuser="$2" pid="$3"; shift 3
  local mode="${CCT_MODE:-hybrid}"
  local fresh=0
  [ "${CLAUDE_CODE_TMUX_FRESH:-0}" = 1 ] && fresh=1  # per-invocation force-create
  [ "$nuser" -gt 0 ] && fresh=1                       # explicit claude args → fresh
  [ "$mode" = create ] && fresh=1
  local cmd="exec claude" sessions target
  # Append the claude argv verbatim, if any. Guard the empty case — `printf '%q'`
  # with no args would emit a stray '' (quoted empty string).
  if [ "$#" -gt 0 ]; then
    cmd="exec claude $(printf '%q ' "$@")"
    cmd=${cmd% }   # strip the trailing space printf %q leaves
  fi
  if [ "$fresh" != 1 ]; then
    sessions=$(_cc_sessions_for_cwd "$dir")
    # A detached session = your left-behind work → reattach (all modes).
    target=$(printf '%s\n' "$sessions" | awk -F'\t' '$1==0 {print $2; exit}')
    # attach mode also reuses an already-attached session (as a 2nd client)
    # rather than spawning a sibling.
    if [ -z "$target" ] && [ "$mode" = attach ]; then
      target=$(printf '%s\n' "$sessions" | awk -F'\t' 'NF{print $2; exit}')
    fi
    if [ -n "$target" ]; then
      printf 'attach\t%s' "$target"
      return
    fi
  fi
  printf 'new\t%s\t%s' "$(_cc_launch_name "$dir" "$pid")" "$cmd"
}

# Entry point called by _cct_launch_claude. $1 = number of user (non-flag) args;
# the rest is the full claude argv (flags + user args). Uses $PWD and $$.
cc_tmux_launch() {
  local nuser="$1"; shift
  local dir="$PWD" plan action rest name cmd
  plan=$(_cc_plan_launch "$dir" "$nuser" "$$" "$@")
  action=${plan%%$'\t'*}
  rest=${plan#*$'\t'}
  case "$action" in
    attach)
      _cc_do_exec tmux -L "$CC_TMUX_SOCKET" attach-session -t "$rest"
      ;;
    new)
      name=${rest%%$'\t'*}
      cmd=${rest#*$'\t'}
      # The name embeds our $$ (unique among live processes), so any EXISTING
      # session with this exact name is a stale orphan from a past process whose
      # pid the OS later handed us. Kill it first, else `new-session` fails with
      # "duplicate session" and Claude never launches.
      tmux -L "$CC_TMUX_SOCKET" kill-session -t "$name" 2>/dev/null
      _cc_do_exec tmux -L "$CC_TMUX_SOCKET" -f "$CC_TMUX_CONF" new-session -s "$name" "$cmd"
      ;;
  esac
}
