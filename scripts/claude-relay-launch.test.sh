#!/usr/bin/env bash
# Test harness for scripts/claude-relay-launch.sh outer-phase tmux dispatch.
# Run: bash scripts/claude-relay-launch.test.sh
#
# /new spawns must run Claude under tmux -L claude (spec:
# docs/superpowers/specs/2026-08-02-new-spawn-tmux-design.md): outer phase
# re-execs the script inside a fresh tmux session (always-create, stale-orphan
# kill), inner phase is the unchanged expect flow. Falls back to inner when
# tmux is unavailable / already inside tmux / CLAUDE_CODE_NO_TMUX=1.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FAILED=0
assert_eq() { # actual expected msg
  if [ "$1" = "$2" ]; then echo "ok   - $3"; else echo "FAIL - $3: got [$1] want [$2]"; FAILED=1; fi
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

# Source the script in test mode: definitions only, no main.
CRL_TEST=1
# shellcheck disable=SC1091
source "$HERE/claude-relay-launch.sh"

# Fake tmux on PATH so `command -v tmux` succeeds and kill-session is captured.
TMPBIN=$(mktemp -d /tmp/crl-test-bin-XXXXXX)
KILL_LOG="$TMPBIN/kill.log"
cat > "$TMPBIN/tmux" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$KILL_LOG"
exit 0
EOF
chmod +x "$TMPBIN/tmux"
PATH="$TMPBIN:$PATH"

# Capture-instead-of-exec seam.
CAPTURED=""
_crl_do_exec() { CAPTURED="$*"; }

# --- _crl_should_wrap gating ---
unset TMUX CC_RELAY_INNER CLAUDE_CODE_NO_TMUX 2>/dev/null || true
_crl_should_wrap && r=yes || r=no
assert_eq "$r" "yes" "wraps by default when tmux present, not nested"

TMUX=/tmp/sock,1,0 _crl_should_wrap && r=yes || r=no
assert_eq "$r" "no" "no double-wrap when already inside tmux"

CLAUDE_CODE_NO_TMUX=1 _crl_should_wrap && r=yes || r=no
assert_eq "$r" "no" "CLAUDE_CODE_NO_TMUX=1 opts out"

CC_RELAY_INNER=1 _crl_should_wrap && r=yes || r=no
assert_eq "$r" "no" "inner phase never re-wraps"

OLDPATH="$PATH"
PATH="/usr/bin:/bin" # no tmux shim; assumes tmux not in /usr/bin:/bin on this box or... guard below
if ! command -v tmux >/dev/null 2>&1; then
  _crl_should_wrap && r=yes || r=no
  assert_eq "$r" "no" "falls back when tmux is not installed"
else
  echo "ok   - (skip) tmux exists in /usr/bin:/bin; fallback covered by gating fn"
fi
PATH="$OLDPATH"

# --- outer exec argv ---
DIR="/tmp/my repo's dir"
mkdir -p "$DIR"
: > "$KILL_LOG"
CAPTURED=""
_crl_exec_outer "$DIR"

# 1) stale orphan with our exact name is killed first — MUST use the `=`
# exact-match sigil: tmux prefix-matches targets, so a bare name could kill a
# live sibling whose pid suffix merely extends ours (123 vs 1234).
expected_name="$(_cc_launch_name "$DIR" "$$")"
assert_match "$(cat "$KILL_LOG")" "-L claude kill-session -t =$expected_name" "stale same-name orphan is killed by EXACT name"

# 2) exec'd argv: dedicated socket + conf + always-new session with our name
assert_match "$CAPTURED" "tmux -L claude -f *claude-tmux.conf new-session -s $expected_name *" "execs tmux new-session on -L claude with conf"

# 3) session name embeds pid (fresh per launch, never attach)
assert_match "$expected_name" "cc-my-repo-s-dir-*-$$" "session name is cc-<base>-<hash>-<pid>"

# 4) the inner command re-invokes THIS script with the marker + quoted dir
assert_match "$CAPTURED" "*CC_RELAY_INNER=1*claude-relay-launch.sh*" "inner command re-invokes script with CC_RELAY_INNER=1"
assert_match "$CAPTURED" "*my\\\\ repo\\\\'s\\\\ dir*" "dir with spaces/quote survives %q quoting"

# 5) per-spawn env must be forwarded IN the command string: with a pre-existing
# tmux server, new-session commands run in the SERVER's env, which silently
# drops spawn-time CLAUDE/CLAUDE_CLI_PATH/CLAUDE_RELAY_ARGS/CRL_EXPECT_TIMEOUT.
CAPTURED=""
: > "$KILL_LOG"
CLAUDE="/opt/custom claude/bin/claude" CLAUDE_RELAY_ARGS="--flag one" \
  CRL_EXPECT_TIMEOUT=9 _crl_exec_outer "/tmp"
assert_match "$CAPTURED" "*CLAUDE=/opt/custom\\\\ claude/bin/claude*" "CLAUDE forwarded through server env boundary"
assert_match "$CAPTURED" "*CLAUDE_RELAY_ARGS=--flag\\\\ one*" "CLAUDE_RELAY_ARGS forwarded"
assert_match "$CAPTURED" "*CRL_EXPECT_TIMEOUT=9*" "CRL_EXPECT_TIMEOUT forwarded"
CAPTURED=""
_crl_exec_outer "/tmp"
assert_no_match "$CAPTURED" "*CLAUDE=*" "unset per-spawn vars are not forwarded as empties"

rm -rf "$DIR"

# --- inner phase: expect must answer prompts through Ink's CHA rendering ---
# Claude's Ink TUI emits cursor-column escapes BETWEEN WORDS
# ("Quick\e[8Gsafety\e[15Gcheck:"), captured live 2026-08-02 — multi-word
# patterns like "safety check" never appear contiguously in the byte stream.
# Fake claude replays those exact bytes; expect must still answer both menus.
FAKE="$TMPBIN/fake-claude"
cat > "$FAKE" <<'FAKEEOF'
#!/usr/bin/env bash
# Decoy FIRST: prose containing the pattern words separated by real words /
# newlines. If the expect patterns are too loose (plain `.` between words),
# they match this, answer prematurely, and the handshake below desyncs —
# E2E_READY is never reached and the test fails.
printf 'Tip: safety first, always check your project setup; you\r\n'
printf 'created it, so trust what this\r\nfolder contains.\r\n'
# A too-loose pattern answers the decoy: catch any input arriving before the
# real prompt is even shown and abort with a marker the test asserts against.
if read -t 1 -r _; then
  printf 'PREMATURE_ANSWER\r\n'
  exit 1
fi
printf 'Quick\033[8Gsafety\033[15Gcheck:\033[22GIs\033[25Gthis\033[30Ga\033[32Gproject\033[40Gyou\033[44Gcreated\r\n'
read -r _
printf 'Loading\033[9Gdevelopment\033[21Gchannels\033[30Gfrom\033[35Gserver\r\n'
read -r _
printf 'E2E_READY\r\n'
sleep 1
FAKEEOF
chmod +x "$FAKE"

# BSD `script -q /dev/null cmd` (macOS). util-linux script needs `-c`; this
# repo targets macOS, so skip (loudly) elsewhere rather than false-fail.
if [ "$(uname)" = "Darwin" ] && [ -x /usr/bin/expect ]; then
  TESTDIR=$(mktemp -d /tmp/crl-inner-XXXXXX)
  OUT=$(CC_RELAY_INNER=1 CLAUDE="$FAKE" CLAUDE_RELAY_ARGS="--fake-args" \
    CRL_EXPECT_TIMEOUT=8 \
    script -q /dev/null bash "$HERE/claude-relay-launch.sh" "$TESTDIR" 2>&1) || true
  assert_match "$OUT" "*E2E_READY*" "expect answers CHA-broken prompts, ignores prose decoys"
  assert_no_match "$OUT" "*PREMATURE_ANSWER*" "expect does not answer prose decoys before the real prompt"
  rm -rf "$TESTDIR"
else
  echo "ok   - (skip) inner-phase pty test needs macOS script(1) + expect"
fi

rm -rf "$TMPBIN"

if [ "$FAILED" = 1 ]; then echo "FAILED"; exit 1; fi
echo "ALL PASS"
