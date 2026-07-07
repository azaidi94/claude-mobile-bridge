#!/usr/bin/env bash
# Test harness for scripts/tmux/launch.sh. Run: bash scripts/tmux/launch.test.sh
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

# --- Task 1: hashing + session name ---
h1=$(_cc_hash8 "/a/b/myrepo")
h2=$(_cc_hash8 "/a/b/myrepo")
assert_eq "$h1" "$h2" "hash is deterministic"
assert_eq "${#h1}" "8" "hash is 8 chars"
assert_ne "$(_cc_hash8 /x/myrepo)" "$(_cc_hash8 /y/myrepo)" "different paths hash differently"

name=$(_cc_session_name "/a/b/myrepo")
assert_eq "$name" "cc-myrepo-$(_cc_hash8 /a/b/myrepo)" "session name = cc-<base>-<hash>"
assert_ne "$(_cc_session_name /x/myrepo)" "$(_cc_session_name /y/myrepo)" "same basename, different path -> different name"
assert_eq "$(_cc_session_name '/tmp/my repo:1')" "cc-my-repo-1-$(_cc_hash8 '/tmp/my repo:1')" "name is sanitized (no space/colon)"

# --- Task 2: decision ---
assert_eq "$(_cc_decide 0 0 0)" "new"    "bare + no existing -> new"
assert_eq "$(_cc_decide 0 0 1)" "attach" "bare + existing -> attach"
assert_eq "$(_cc_decide 0 2 1)" "fresh"  "args present -> fresh even if existing"
assert_eq "$(_cc_decide 1 0 1)" "fresh"  "FRESH=1 -> fresh even if existing"
assert_eq "$(_cc_decide 1 0 0)" "fresh"  "FRESH=1 + no existing -> fresh"

# --- Task 3: sessions-for-cwd (mock tmux) ---
tmux() {
  # Mock: only the list-panes form is exercised here.
  if [ "$3" = "list-panes" ]; then
    printf '%s\n' \
      "/a/b/myrepo	1	cc-myrepo-aaaa" \
      "/a/b/myrepo	0	cc-myrepo-old12345" \
      "/other/dir	0	cc-other-bbbb"
  fi
}
out=$(_cc_sessions_for_cwd "/a/b/myrepo")
assert_eq "$out" "$(printf '1\tcc-myrepo-aaaa\n0\tcc-myrepo-old12345')" "lists only matching-cwd sessions with attached flag"
assert_eq "$(_cc_sessions_for_cwd /nope)" "" "no match -> empty"
unset -f tmux

# --- Task 4: reap detached siblings (mock tmux + mock sessions) ---
_cc_sessions_for_cwd() { printf '%s\n' "1	cc-keep-attached" "0	cc-orphan-1" "0	cc-orphan-2"; }
KILLED=""
tmux() { if [ "$3" = "kill-session" ]; then KILLED="$KILLED $5"; fi; }

_cc_reap_detached "/a/b/myrepo"
assert_eq "$KILLED" " cc-orphan-1 cc-orphan-2" "reaps only detached sessions"

KILLED=""
CLAUDE_CODE_TMUX_NO_REAP=1 _cc_reap_detached "/a/b/myrepo"
assert_eq "$KILLED" "" "NO_REAP=1 disables reaping"

unset -f tmux _cc_sessions_for_cwd
source "$HERE/launch.sh"  # restore real _cc_sessions_for_cwd for later tasks

# --- Task 5: pure planner ---
# no existing sessions -> new
_cc_sessions_for_cwd() { printf ''; }
line=$(CLAUDE_CODE_TMUX_FRESH=0 _cc_plan_launch "/a/b/myrepo" 0 999 --flag)
assert_eq "$line" "$(printf 'new\tcc-myrepo-%s\texec claude --flag' "$(_cc_hash8 /a/b/myrepo)")" "no session -> new with canonical name"

# existing detached + attached -> attach, prefer detached
_cc_sessions_for_cwd() { printf '%s\n' "1	cc-myrepo-att" "0	cc-myrepo-det"; }
line=$(CLAUDE_CODE_TMUX_FRESH=0 _cc_plan_launch "/a/b/myrepo" 0 999)
assert_eq "$line" "$(printf 'attach\tcc-myrepo-det')" "existing -> attach, prefers detached target"

# only attached -> attach to it
_cc_sessions_for_cwd() { printf '%s\n' "1	cc-myrepo-att"; }
line=$(_cc_plan_launch "/a/b/myrepo" 0 999)
assert_eq "$line" "$(printf 'attach\tcc-myrepo-att')" "only attached -> attach as second client"

# args present -> fresh with -pid suffix, ignores existing
_cc_sessions_for_cwd() { printf '%s\n' "0	cc-myrepo-det"; }
line=$(_cc_plan_launch "/a/b/myrepo" 1 999 --resume)
assert_eq "$line" "$(printf 'fresh\tcc-myrepo-%s-999\texec claude --resume' "$(_cc_hash8 /a/b/myrepo)")" "args -> fresh session with pid suffix"

# FRESH=1 forces fresh even with no args
line=$(CLAUDE_CODE_TMUX_FRESH=1 _cc_plan_launch "/a/b/myrepo" 0 999 --flag)
assert_eq "$line" "$(printf 'fresh\tcc-myrepo-%s-999\texec claude --flag' "$(_cc_hash8 /a/b/myrepo)")" "FRESH=1 -> fresh"

unset -f _cc_sessions_for_cwd
source "$HERE/launch.sh"

# --- Task 6: entrypoint (capture exec via _cc_do_exec seam) ---
CAPTURED=""; REAPED=""
_cc_do_exec() { CAPTURED="$*"; }              # override the exec seam
_cc_reap_detached() { REAPED="yes"; }         # observe reaping

# new path — pushd (NOT a subshell) so CAPTURED survives into the test shell
_cc_sessions_for_cwd() { printf ''; }
CAPTURED=""; REAPED=""
pushd "$HERE" >/dev/null
cc_tmux_launch 0 --flag                        # nuser=0, one claude flag; $PWD == $HERE
popd >/dev/null
exp_name="cc-$(basename "$HERE" | tr -c 'A-Za-z0-9_' '-' | sed 's/--*/-/g; s/-$//')-$(_cc_hash8 "$HERE")"
# NOTE: the --session-id addition (below) pins a fresh uuid into new-session
# launches, so this now matches with a wildcard uuid rather than an exact cmd.
assert_match "$CAPTURED" "tmux -L claude -f $CC_TMUX_CONF new-session -s $exp_name exec claude --session-id * --flag" "new -> new-session, canonical name (pinned session-id)"
assert_eq "$REAPED" "" "new path does not reap"

# attach path
_cc_sessions_for_cwd() { printf '%s\n' "0	cc-existing"; }
CAPTURED=""; REAPED=""
cc_tmux_launch 0
assert_eq "$CAPTURED" "tmux -L claude attach-session -t cc-existing" "attach -> attach-session"

# fresh path reaps first
_cc_sessions_for_cwd() { printf '%s\n' "0	cc-existing"; }
CAPTURED=""; REAPED=""
cc_tmux_launch 1 --resume
assert_eq "$REAPED" "yes" "fresh path reaps detached siblings"
case "$CAPTURED" in
  "tmux -L claude -f $CC_TMUX_CONF new-session -s cc-"*"-$$ exec claude --resume")
    echo "ok   - fresh -> new-session with -pid suffix" ;;
  *) echo "FAIL - fresh capture: [$CAPTURED]"; FAILED=1 ;;
esac

unset -f _cc_do_exec _cc_reap_detached _cc_sessions_for_cwd
source "$HERE/launch.sh"

# --- Addition: _cc_should_pin_id ---
if _cc_should_pin_id --flag --other; then
  echo "ok   - no session-selecting flag -> should pin"
else
  echo "FAIL - no session-selecting flag -> should pin"; FAILED=1
fi
for flag in --session-id --resume -r --continue -c; do
  if _cc_should_pin_id "$flag" --extra; then
    echo "FAIL - $flag present -> should NOT pin"; FAILED=1
  else
    echo "ok   - $flag present -> should NOT pin"
  fi
done

# --- Addition: --session-id pinning wired into cc_tmux_launch (new/fresh only) ---
UUID_RE='????????-????-????-????-????????????'

# bare launch (no args) -> new path -> pinned session-id present
CAPTURED=""; REAPED=""
_cc_do_exec() { CAPTURED="$*"; }
_cc_reap_detached() { REAPED="yes"; }
_cc_sessions_for_cwd() { printf ''; }
cc_tmux_launch 0
case "$CAPTURED" in
  *"exec claude --session-id "$UUID_RE*)
    echo "ok   - bare new launch pins a --session-id uuid" ;;
  *) echo "FAIL - bare new launch missing --session-id: [$CAPTURED]"; FAILED=1 ;;
esac

# launch with --resume -> fresh path (args-bearing) -> NOT pinned
CAPTURED=""
_cc_sessions_for_cwd() { printf ''; }
cc_tmux_launch 1 --resume
assert_no_match "$CAPTURED" "*--session-id*" "--resume args -> no --session-id pin"

# launch with --continue -> fresh path -> NOT pinned
CAPTURED=""
cc_tmux_launch 1 --continue
assert_no_match "$CAPTURED" "*--session-id*" "--continue args -> no --session-id pin"

# attach path -> no claude cmd at all, no --session-id
CAPTURED=""
_cc_sessions_for_cwd() { printf '%s\n' "0	cc-existing"; }
cc_tmux_launch 0
assert_eq "$CAPTURED" "tmux -L claude attach-session -t cc-existing" "attach path launches no claude cmd"
assert_no_match "$CAPTURED" "*--session-id*" "attach path -> no --session-id pin"

unset -f _cc_do_exec _cc_reap_detached _cc_sessions_for_cwd
source "$HERE/launch.sh"

echo
if [ "$FAILED" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; exit 1; fi
