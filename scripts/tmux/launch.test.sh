#!/usr/bin/env bash
# Test harness for scripts/tmux/launch.sh. Run: bash scripts/tmux/launch.test.sh
#
# launch.sh is HYBRID reattach-or-create:
#   - a DETACHED session in this dir (your left-behind work) → attach to it;
#   - sessions exist but all ATTACHED (you're viewing one elsewhere) → create a
#     new sibling rather than mirror;
#   - no session → create.
# Explicit claude args or CLAUDE_CODE_TMUX_FRESH=1 → always create. New sessions
# are named cc-<base>-<hash8>-<pid> (siblings coexist), identified by the bridge
# via the hook-minted launchUuid, so NO --session-id pin.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/launch.sh"

FAILED=0
assert_eq() { # actual expected msg
  if [ "$1" = "$2" ]; then echo "ok   - $3"; else echo "FAIL - $3: got [$1] want [$2]"; FAILED=1; fi
}
assert_ne() { # a b msg
  if [ "$1" != "$2" ]; then echo "ok   - $3"; else echo "FAIL - $3: [$1] == [$2] but should differ"; FAILED=1; fi
}
assert_match() { # haystack pattern msg
  case "$1" in
    $2) echo "ok   - $3" ;;
    *) echo "FAIL - $3: [$1] does not match [$2]"; FAILED=1 ;;
  esac
}
assert_no_match() { # haystack pattern msg
  case "$1" in
    $2) echo "FAIL - $3: [$1] unexpectedly matches [$2]"; FAILED=1 ;;
    *) echo "ok   - $3" ;;
  esac
}

# --- hashing + base session name (path-disambiguated) ---
h1=$(_cc_hash8 "/a/b/myrepo")
assert_eq "${#h1}" "8" "hash is 8 chars"
assert_ne "$(_cc_hash8 /x/myrepo)" "$(_cc_hash8 /y/myrepo)" "different paths hash differently"
assert_eq "$(_cc_session_name /a/b/myrepo)" "cc-myrepo-$(_cc_hash8 /a/b/myrepo)" "base name = cc-<base>-<hash>"
assert_eq "$(_cc_session_name '/tmp/my repo:1')" "cc-my-repo-1-$(_cc_hash8 '/tmp/my repo:1')" "name is sanitized"

# --- per-launch unique name: cc-<base>-<hash8>-<pid> ---
assert_eq "$(_cc_launch_name /a/b/myrepo 999)" "cc-myrepo-$(_cc_hash8 /a/b/myrepo)-999" "launch name appends the pid"
assert_ne "$(_cc_launch_name /a/b/myrepo 111)" "$(_cc_launch_name /a/b/myrepo 222)" "different pid -> different session"

# --- hybrid planner ---
NAME_FOR() { printf 'cc-myrepo-%s-999' "$(_cc_hash8 /a/b/myrepo)"; }

# no sessions -> create
_cc_sessions_for_cwd() { printf ''; }
line=$(CLAUDE_CODE_TMUX_FRESH=0 _cc_plan_launch "/a/b/myrepo" 0 999 --flag)
assert_eq "$line" "$(printf 'new\t%s\texec claude --flag' "$(NAME_FOR)")" "no session -> create"

# one DETACHED session -> attach to it (reattach my work)
_cc_sessions_for_cwd() { printf '%s\n' "0	cc-myrepo-det"; }
line=$(_cc_plan_launch "/a/b/myrepo" 0 999)
assert_eq "$line" "attach	cc-myrepo-det" "one detached -> attach to it"

# sessions exist but ALL ATTACHED -> create a sibling
_cc_sessions_for_cwd() { printf '%s\n' "1	cc-myrepo-att"; }
line=$(_cc_plan_launch "/a/b/myrepo" 0 999)
assert_eq "$line" "$(printf 'new\t%s\texec claude' "$(NAME_FOR)")" "all attached -> create sibling"

# mix: prefer the DETACHED one to attach
_cc_sessions_for_cwd() { printf '%s\n' "1	cc-myrepo-att" "0	cc-myrepo-det"; }
line=$(_cc_plan_launch "/a/b/myrepo" 0 999)
assert_eq "$line" "attach	cc-myrepo-det" "attached + detached -> attach the detached"

# FRESH=1 forces create even when a detached session exists
_cc_sessions_for_cwd() { printf '%s\n' "0	cc-myrepo-det"; }
line=$(CLAUDE_CODE_TMUX_FRESH=1 _cc_plan_launch "/a/b/myrepo" 0 999 --flag)
assert_eq "$line" "$(printf 'new\t%s\texec claude --flag' "$(NAME_FOR)")" "FRESH=1 -> create even with a detached session"

# explicit claude args (nuser>0) force create (don't reattach — new invocation)
_cc_sessions_for_cwd() { printf '%s\n' "0	cc-myrepo-det"; }
line=$(_cc_plan_launch "/a/b/myrepo" 1 999 --resume)
assert_eq "$line" "$(printf 'new\t%s\texec claude --resume' "$(NAME_FOR)")" "args present -> create, argv passed through"

# --- CCT_MODE override ---
# CCT_MODE=create: always new, even with a detached session present
_cc_sessions_for_cwd() { printf '%s\n' "0	cc-myrepo-det"; }
line=$(CCT_MODE=create _cc_plan_launch "/a/b/myrepo" 0 999)
assert_eq "$line" "$(printf 'new\t%s\texec claude' "$(NAME_FOR)")" "CCT_MODE=create -> always create (ignores detached)"

# CCT_MODE=attach: reuse an ATTACHED session (2nd client) when no detached exists
_cc_sessions_for_cwd() { printf '%s\n' "1	cc-myrepo-att"; }
line=$(CCT_MODE=attach _cc_plan_launch "/a/b/myrepo" 0 999)
assert_eq "$line" "attach	cc-myrepo-att" "CCT_MODE=attach + all-attached -> attach (2nd client), never sibling"

# CCT_MODE=attach still prefers a detached session
_cc_sessions_for_cwd() { printf '%s\n' "1	cc-myrepo-att" "0	cc-myrepo-det"; }
line=$(CCT_MODE=attach _cc_plan_launch "/a/b/myrepo" 0 999)
assert_eq "$line" "attach	cc-myrepo-det" "CCT_MODE=attach prefers a detached session"

# CCT_MODE=attach with no session -> create
_cc_sessions_for_cwd() { printf ''; }
line=$(CCT_MODE=attach _cc_plan_launch "/a/b/myrepo" 0 999)
assert_eq "$line" "$(printf 'new\t%s\texec claude' "$(NAME_FOR)")" "CCT_MODE=attach + no session -> create"

# CCT_MODE=hybrid (explicit) == default: all-attached -> create sibling
_cc_sessions_for_cwd() { printf '%s\n' "1	cc-myrepo-att"; }
line=$(CCT_MODE=hybrid _cc_plan_launch "/a/b/myrepo" 0 999)
assert_eq "$line" "$(printf 'new\t%s\texec claude' "$(NAME_FOR)")" "CCT_MODE=hybrid + all-attached -> create sibling"

# FRESH=1 overrides CCT_MODE=attach -> create
_cc_sessions_for_cwd() { printf '%s\n' "0	cc-myrepo-det"; }
line=$(CCT_MODE=attach CLAUDE_CODE_TMUX_FRESH=1 _cc_plan_launch "/a/b/myrepo" 0 999)
assert_eq "$line" "$(printf 'new\t%s\texec claude' "$(NAME_FOR)")" "FRESH=1 overrides CCT_MODE=attach -> create"

unset -f _cc_sessions_for_cwd
source "$HERE/launch.sh"

# --- entrypoint (capture exec via _cc_do_exec seam) ---
_cc_do_exec() { CAPTURED="$*"; }

# bare launch, no existing session -> new-session, unique name, no --session-id
_cc_sessions_for_cwd() { printf ''; }
CAPTURED=""
pushd "$HERE" >/dev/null
cc_tmux_launch 0 --flag
popd >/dev/null
exp_name="cc-$(basename "$HERE" | tr -c 'A-Za-z0-9_' '-' | sed 's/--*/-/g; s/-$//')-$(_cc_hash8 "$HERE")-$$"
assert_match "$CAPTURED" "tmux -L claude -f $CC_TMUX_CONF new-session -s $exp_name exec claude --flag" "bare + no session -> new-session, unique name"
assert_no_match "$CAPTURED" "*--session-id*" "launcher does NOT pin --session-id (hook owns identity)"

# a detached session present -> attach to it
_cc_sessions_for_cwd() { printf '%s\n' "0	cc-existing-det"; }
CAPTURED=""
cc_tmux_launch 0
assert_eq "$CAPTURED" "tmux -L claude attach-session -t cc-existing-det" "detached present -> attach-session"

# all-attached -> create a sibling, killing any stale same-named session first
_cc_sessions_for_cwd() { printf '%s\n' "1	cc-existing-att"; }
KILLED=""
tmux() { if [ "$3" = "kill-session" ]; then KILLED="$5"; fi; }
CAPTURED=""
pushd "$HERE" >/dev/null
cc_tmux_launch 0
popd >/dev/null
assert_match "$CAPTURED" "tmux -L claude -f $CC_TMUX_CONF new-session -s cc-*-$$ exec claude" "all-attached -> new-session sibling"
# `=` sigil: tmux prefix-matches bare targets, so killing without it can hit a
# live sibling whose name merely extends ours (…-123 matches …-1234).
assert_eq "$KILLED" "=$exp_name" "create path kills stale same-named session by EXACT name"
unset -f tmux

unset -f _cc_do_exec _cc_sessions_for_cwd

echo
if [ "$FAILED" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; exit 1; fi
