# ccd tmux Single-Session-Per-Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the `ccd`/`cc` tmux launcher from accumulating multiple live Claude sessions in the same directory, which spams the bot's topic watcher with `🔄 started a new conversation` rebinds.

**Architecture:** Extract the launcher's tmux logic from `~/.bash_profile` into a version-controlled, testable shell library (`scripts/tmux/launch.sh`). Replace "always `new-session` with a unique `-$$` name" with **attach-or-create keyed on the full working directory**: a bare `cc`/`ccd` attaches to the one live session for that cwd if it exists (else creates it); args-bearing launches (`ccc`/`ccr`/`ccp`, or a prompt) start a fresh session but first reap any _detached_ sibling sessions for that cwd. An explicit `CLAUDE_CODE_TMUX_FRESH=1` forces a new parallel session on demand.

**Tech Stack:** Bash (macOS `/bin/bash` 3.2 and Homebrew bash), tmux on a dedicated `-L claude` socket, `md5`/`md5sum` for path hashing. Tests are plain bash with a mock `tmux` function — no bats dependency.

## Global Constraints

- Target shell: macOS bash. Do **not** use bash-4-only features (no associative arrays, no `${x^^}`). `printf`, `awk`, `tr`, `cut`, `grep` only.
- tmux always runs on the dedicated socket `-L claude` with `-f "$conf"` where `conf="$HOME/Projects/Cursor/AHZ/claude-mobile-bridge/scripts/claude-tmux.conf"`. Never touch the user's default tmux socket.
- New sessions launch the pane command as `exec claude <args>` so the tmux session dies when Claude exits (no zombie sessions holding a dead shell).
- Preserve every existing opt-out unchanged: `CLAUDE_CODE_NO_TMUX=1` (bare `claude`, no tmux), `CLAUDE_CODE_NO_RELAY=1`, `CLAUDE_CODE_NO_SKIP_PERMS=1`, and the `[ -z "${TMUX:-}" ]` guard (never nest tmux).
- New env knobs: `CLAUDE_CODE_TMUX_FRESH=1` forces a fresh parallel session; `CLAUDE_CODE_TMUX_NO_REAP=1` disables auto-reaping of detached siblings.
- Reaping only ever kills sessions whose pane cwd equals the launch cwd **and** whose `session_attached` is `0`. Never kill an attached session.
- Development target is `~/.bash_profile.tmux-wip` (the stashed tmux version). `~/.bash_profile` is currently reverted to direct-terminal and must NOT be modified until the final opt-in task, which the user runs deliberately.
- Session names must be tmux-safe: no `.` or `:` characters.

---

## File Structure

- **Create `scripts/tmux/launch.sh`** — sourced shell library. Pure helpers (`_cc_hash8`, `_cc_session_name`, `_cc_decide`), IO helpers (`_cc_sessions_for_cwd`, `_cc_reap_detached`), a pure planner (`_cc_plan_launch`), and the exec entrypoint (`cc_tmux_launch`). One responsibility: decide-and-launch the tmux session for a cwd.
- **Create `scripts/tmux/launch.test.sh`** — plain-bash test harness. Sources `launch.sh`, defines a mock `tmux` and mock `_cc_sessions_for_cwd`, runs assertions, exits non-zero on any failure.
- **Modify `~/.bash_profile.tmux-wip`** — replace the inline tmux block inside `_ccd_launch_claude` with a `source` of `launch.sh` plus a call to `cc_tmux_launch`.
- **Modify `~/.bash_profile`** — final opt-in task only: copy the working `.tmux-wip` launcher across to re-enable tmux with the fix.

---

### Task 1: Path hashing + deterministic session name

**Files:**

- Create: `scripts/tmux/launch.sh`
- Test: `scripts/tmux/launch.test.sh`

**Interfaces:**

- Produces: `_cc_hash8 <string>` → prints 8-char hex hash. `_cc_session_name <dir>` → prints `cc-<sanitized-basename>-<hash8-of-full-dir>`.

- [ ] **Step 1: Write the failing test**

Create `scripts/tmux/launch.test.sh`:

```bash
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

echo
if [ "$FAILED" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; exit 1; fi
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/tmux/launch.test.sh`
Expected: FAIL — `source .../launch.sh` errors because the file does not exist yet (`No such file or directory`).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/tmux/launch.sh`:

```bash
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/tmux/launch.test.sh`
Expected: PASS — all Task-1 assertions print `ok`, final line `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add scripts/tmux/launch.sh scripts/tmux/launch.test.sh
git commit -m "feat(tmux): deterministic per-cwd session name for cc launcher"
```

---

### Task 2: Pure launch decision

**Files:**

- Modify: `scripts/tmux/launch.sh`
- Test: `scripts/tmux/launch.test.sh`

**Interfaces:**

- Consumes: nothing from tmux — pure function.
- Produces: `_cc_decide <fresh:0|1> <nuser:int> <existing:int>` → prints `fresh` | `attach` | `new`.
  - `fresh=1` OR `nuser>0` → `fresh` (args-bearing or forced-parallel launches always start their own session).
  - else `existing>0` → `attach` (a live session for this cwd exists — reuse it).
  - else → `new` (no session yet — create the canonical one).

- [ ] **Step 1: Write the failing test**

Append to `scripts/tmux/launch.test.sh` before the final `echo`:

```bash
# --- Task 2: decision ---
assert_eq "$(_cc_decide 0 0 0)" "new"    "bare + no existing -> new"
assert_eq "$(_cc_decide 0 0 1)" "attach" "bare + existing -> attach"
assert_eq "$(_cc_decide 0 2 1)" "fresh"  "args present -> fresh even if existing"
assert_eq "$(_cc_decide 1 0 1)" "fresh"  "FRESH=1 -> fresh even if existing"
assert_eq "$(_cc_decide 1 0 0)" "fresh"  "FRESH=1 + no existing -> fresh"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/tmux/launch.test.sh`
Expected: FAIL — `_cc_decide: command not found` on the new assertions.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/tmux/launch.sh`:

```bash
# Decide the launch action. Pure — no IO. See interface notes in the plan.
_cc_decide() {
  local fresh="$1" nuser="$2" existing="$3"
  if [ "$fresh" = 1 ] || [ "$nuser" -gt 0 ]; then echo "fresh"; return; fi
  if [ "$existing" -gt 0 ]; then echo "attach"; else echo "new"; fi
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/tmux/launch.test.sh`
Expected: PASS — `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add scripts/tmux/launch.sh scripts/tmux/launch.test.sh
git commit -m "feat(tmux): pure attach-or-create decision function"
```

---

### Task 3: Query sessions for a cwd

**Files:**

- Modify: `scripts/tmux/launch.sh`
- Test: `scripts/tmux/launch.test.sh`

**Interfaces:**

- Consumes: `tmux -L claude list-panes -a -F ...` (mocked in tests).
- Produces: `_cc_sessions_for_cwd <dir>` → prints zero or more lines, each `<attached>\t<session_name>`, only for sessions whose pane cwd equals `<dir>`. `<attached>` is `1` or `0`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tmux/launch.test.sh` before the final `echo`:

```bash
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/tmux/launch.test.sh`
Expected: FAIL — `_cc_sessions_for_cwd: command not found`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/tmux/launch.sh`:

```bash
# List live sessions whose pane cwd == dir. Output: "<attached>\t<name>" lines.
_cc_sessions_for_cwd() {
  local dir="${1:-$PWD}"
  tmux -L "$CC_TMUX_SOCKET" list-panes -a \
    -F '#{pane_current_path}	#{session_attached}	#{session_name}' 2>/dev/null \
    | awk -F'\t' -v d="$dir" '$1==d { print $2"\t"$3 }'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/tmux/launch.test.sh`
Expected: PASS — `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add scripts/tmux/launch.sh scripts/tmux/launch.test.sh
git commit -m "feat(tmux): list live sessions for a working directory"
```

---

### Task 4: Reap detached siblings

**Files:**

- Modify: `scripts/tmux/launch.sh`
- Test: `scripts/tmux/launch.test.sh`

**Interfaces:**

- Consumes: `_cc_sessions_for_cwd`, `tmux -L claude kill-session -t <name>` (mocked).
- Produces: `_cc_reap_detached <dir>` → kills every session for `<dir>` whose attached flag is `0`. No-op when `CLAUDE_CODE_TMUX_NO_REAP=1`. Never kills attached sessions.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tmux/launch.test.sh` before the final `echo`:

```bash
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/tmux/launch.test.sh`
Expected: FAIL — `_cc_reap_detached: command not found`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/tmux/launch.sh`:

```bash
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/tmux/launch.test.sh`
Expected: PASS — `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add scripts/tmux/launch.sh scripts/tmux/launch.test.sh
git commit -m "feat(tmux): reap detached sibling sessions on fresh launch"
```

---

### Task 5: Launch planner (pure, no exec)

**Files:**

- Modify: `scripts/tmux/launch.sh`
- Test: `scripts/tmux/launch.test.sh`

**Interfaces:**

- Consumes: `_cc_sessions_for_cwd`, `_cc_decide`, `_cc_session_name`.
- Produces: `_cc_plan_launch <dir> <nuser> <pid> <claude_arg>...` → prints exactly one line describing the tmux command to run, tab-separated:
  - `attach\t<target-session>` — target prefers a detached session for the cwd, else the first listed.
  - `new\t<session-name>\texec claude <args>`
  - `fresh\t<session-name>-<pid>\texec claude <args>`
  - Reads `CLAUDE_CODE_TMUX_FRESH` for the fresh flag. Does NOT exec and does NOT reap (side effects live in `cc_tmux_launch`), so it is unit-testable.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tmux/launch.test.sh` before the final `echo`:

```bash
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/tmux/launch.test.sh`
Expected: FAIL — `_cc_plan_launch: command not found`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/tmux/launch.sh`:

```bash
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/tmux/launch.test.sh`
Expected: PASS — `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add scripts/tmux/launch.sh scripts/tmux/launch.test.sh
git commit -m "feat(tmux): pure launch planner (attach/new/fresh)"
```

---

### Task 6: Exec entrypoint

**Files:**

- Modify: `scripts/tmux/launch.sh`
- Test: `scripts/tmux/launch.test.sh`

**Interfaces:**

- Consumes: `_cc_plan_launch`, `_cc_reap_detached`, `tmux`.
- Produces: `cc_tmux_launch <nuser> <claude_arg>...` → reaps detached siblings when the plan is `fresh`, then `exec`s the tmux command. Uses `$PWD` as the cwd and `$$` as the pid. Because `exec` replaces the shell, the test overrides `_cc_do_exec` (a thin seam) to capture the argv instead of running it.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tmux/launch.test.sh` before the final `echo`:

```bash
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
assert_eq "$CAPTURED" "tmux -L claude -f $CC_TMUX_CONF new-session -s $exp_name exec claude --flag" "new -> new-session, canonical name"
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/tmux/launch.test.sh`
Expected: FAIL — `cc_tmux_launch: command not found`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/tmux/launch.sh`:

```bash
# Exec seam — overridden in tests to capture argv instead of replacing the shell.
_cc_do_exec() { exec "$@"; }

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
      _cc_do_exec tmux -L "$CC_TMUX_SOCKET" -f "$CC_TMUX_CONF" new-session -s "$name" "$cmd"
      ;;
    fresh)
      name=${rest%%$'\t'*}
      cmd=${rest#*$'\t'}
      _cc_reap_detached "$dir"
      _cc_do_exec tmux -L "$CC_TMUX_SOCKET" -f "$CC_TMUX_CONF" new-session -s "$name" "$cmd"
      ;;
  esac
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/tmux/launch.test.sh`
Expected: PASS — every assertion `ok`, final `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add scripts/tmux/launch.sh scripts/tmux/launch.test.sh
git commit -m "feat(tmux): attach-or-create exec entrypoint with fresh-launch reaping"
```

---

### Task 7: Wire the library into the dev launcher (`.tmux-wip`)

**Files:**

- Modify: `~/.bash_profile.tmux-wip` (the stashed tmux version — NOT `~/.bash_profile`)

**Interfaces:**

- Consumes: `cc_tmux_launch` from `scripts/tmux/launch.sh`.
- Produces: a `_ccd_launch_claude` whose tmux branch delegates to `cc_tmux_launch`, counting user args as `$#` at the point of call (flags are appended after).

- [ ] **Step 1: Replace the inline tmux block**

In `~/.bash_profile.tmux-wip`, the current `_ccd_launch_claude` has this block (lines ~94–103):

```bash
	if [ "${CLAUDE_CODE_NO_TMUX:-}" != 1 ] && [ -z "${TMUX:-}" ] && command -v tmux > /dev/null 2>&1; then
		local conf="$HOME/Projects/Cursor/AHZ/claude-mobile-bridge/scripts/claude-tmux.conf"
		local cmd
		printf -v cmd 'exec claude %s' "$(printf '%q ' "${flags[@]}" "$@")"
		exec tmux -L claude -f "$conf" new-session -s "cc-$(basename "$PWD")-$$" "$cmd"
	fi
```

Replace it with (note: capture `$#` — the user arg count — BEFORE building the combined argv):

```bash
	if [ "${CLAUDE_CODE_NO_TMUX:-}" != 1 ] && [ -z "${TMUX:-}" ] && command -v tmux > /dev/null 2>&1; then
		local nuser=$#
		source "$HOME/Projects/Cursor/AHZ/claude-mobile-bridge/scripts/tmux/launch.sh"
		cc_tmux_launch "$nuser" "${flags[@]}" "$@"
	fi
```

The trailing `claude "${flags[@]}" "$@"` line stays as the non-tmux fallback (reached only when `cc_tmux_launch` doesn't `exec` — e.g. a plan branch that no-ops, which shouldn't happen, but the fallback is harmless).

- [ ] **Step 2: Verify the edited function sources cleanly**

Run:

```bash
bash -n ~/.bash_profile.tmux-wip && echo "syntax ok"
```

Expected: `syntax ok` (no parse errors).

- [ ] **Step 3: Smoke-test the wiring against a real tmux without launching Claude**

Run (this exercises name/decision/attach logic on a throwaway socket-free path by dry-printing the plan):

```bash
source ~/Projects/Cursor/AHZ/claude-mobile-bridge/scripts/tmux/launch.sh
_cc_do_exec() { echo "WOULD EXEC: $*"; }   # override so nothing launches
cd /tmp && cc_tmux_launch 0
```

Expected: prints `WOULD EXEC: tmux -L claude -f .../claude-tmux.conf new-session -s cc-tmp-<hash> exec claude` (a `new` plan, since no Claude session exists for `/tmp`). Then `unset -f _cc_do_exec`.

- [ ] **Step 4: Commit the launch library (the dotfile itself is outside the repo)**

The `.tmux-wip` file lives in `$HOME` and is not tracked here; no repo commit for it. Confirm the repo library is already committed from Tasks 1–6:

```bash
git status --short scripts/tmux/
```

Expected: clean (all of `scripts/tmux/` already committed).

---

### Task 8: Opt-in — re-enable tmux in the live `.bash_profile` (USER-RUN)

**Files:**

- Modify: `~/.bash_profile`

**This task is deliberately gated — the user runs it when they choose to go back to tmux.** Do not perform it automatically.

- [ ] **Step 1: Back up the current (reverted) profile**

```bash
cp ~/.bash_profile ~/.bash_profile.bak-preretmux-$(date +%s)
```

- [ ] **Step 2: Copy the fixed launcher into the live profile**

```bash
cp ~/.bash_profile.tmux-wip ~/.bash_profile
```

(`.tmux-wip` now contains the Task-7 wiring.)

- [ ] **Step 3: Reload and verify a single session per cwd**

```bash
source ~/.bash_profile
cd ~/Projects/Cursor/AHZ/claude-mobile-bridge
# First launch creates one session; open a second terminal, run `ccd` again in
# the same dir — it should ATTACH to the same session, not create a second.
tmux -L claude list-sessions
```

Expected: exactly one `cc-claude-mobile-bridge-<hash>` session for this directory regardless of how many terminals ran `ccd`.

- [ ] **Step 4: Confirm the watcher spam is gone**

```bash
tail -f ~/Library/Logs/claude-mobile-bridge/bot.log | grep --line-buffered "restarted tailer for new conversation"
```

Expected: no new lines appear over ~60s while a single session runs (Ctrl-C to stop). Contrast with the pre-fix ~10s cadence.

---

## Notes / Open Decision

- **Auto-reap default:** This plan defaults to **auto-reaping detached siblings on fresh launches** (`CLAUDE_CODE_TMUX_NO_REAP=1` to disable). This was the recommended option; the alternative (manual `ccreap` only) was left unconfirmed. If you prefer manual-only, drop the `_cc_reap_detached "$dir"` call from the `fresh` branch in Task 6 and instead expose `_cc_reap_detached` as a standalone `ccreap()` alias. Everything else is unchanged.
- **Relationship to the durable fix:** this makes accumulation impossible _from the launcher_, which removes the trigger. The bridge-side identity consolidation (bind the watch to an authoritative sessionId instead of "newest JSONL in dir") is still the belt-and-suspenders fix for any sibling case that arises another way (e.g. Cursor-spawned sessions), tracked separately.

```

```
