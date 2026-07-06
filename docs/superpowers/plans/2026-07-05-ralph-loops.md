# Ralph loops from Telegram — `/ralph`

Start, watch, and stop ralph loops (`afk_tasks.sh`) from the bot. One loop at a time. Visible desktop terminal. Distilled progress in a dedicated topic, with optional full-transcript verbose mode.

## Where the ralph logic lives (portability)

The loop script is **vendored into this repo** so any user gets it on clone:

- `scripts/ralph/afk_tasks.sh` — copied from `~/.claude/scripts/ralph/afk_tasks.sh` with exactly one change: the prompt resolution becomes
  `PROMPT_FILE="${RALPH_PROMPT:-$(cd "$(dirname "$0")" && pwd)/prompt_tasks.md}"`
  (replacing the hardcoded `$HOME/.claude/scripts/ralph/prompt_tasks.md`; keep the target-repo `plans/prompt_tasks.md` override, which still wins when present).
- `scripts/ralph/prompt_tasks.md` — copied verbatim from `~/.claude/scripts/ralph/prompt_tasks.md`.

Customization surface (document in `docs/ralph-loops.md`):

| Want                        | How                                                             |
| --------------------------- | --------------------------------------------------------------- |
| custom prompt for one repo  | `plans/prompt_tasks.md` in that repo (existing script behavior) |
| custom prompt everywhere    | `RALPH_PROMPT=/path/to/prompt.md` in `.env`                     |
| entirely custom loop script | `RALPH_SCRIPT=/path/to/script.sh` in `.env`                     |

Both env vars go in `src/config.ts` + `.env.example`; the start flow (step 5) embeds whichever are set into the terminal shell command. `RALPH_SCRIPT` is how Ali keeps using his personal `~/.claude/scripts/ralph/` copy.

**Custom-script contract**: rich per-iteration beats come from parsing the vendored script's echo markers (table below) — a custom script only gets them by emitting the same lines. Missing markers must degrade gracefully, never break: pid/exit/meta tracking gives ▶️ 🏁 🛑 ⚠️ beats regardless, and verbose transcript streaming is marker-independent (session JSONL). The monitor must not assume markers ever appear.

**Never modify anything under `~/.claude/scripts/ralph/`** — that's the user's personal, separately-versioned copy. The vendored fork under `scripts/ralph/` is the repo's to own. Both scripts must be committed executable (`chmod +x`).

## Background: what a ralph loop is

`afk_tasks.sh <N> [-pr] [-l label]`. Per iteration it:

1. Echoes `=== Iteration N/M ===`
2. Fetches open GitHub issues via `gh issue list` (echoes `Tasks exist - slim fetch…` or `First run - full fetch…`)
3. Spawns a fresh `claude --dangerously-skip-permissions` **under `script -q "$tmpfile"`** — claude needs a real tty (Task tools require interactive mode)
4. Claude works ONE issue, writes COMPLETE/WAITING/DONE to a signal file; a watchdog kills the session
5. Loops, or exits echoing one of the terminal markers below

Terminal-state lines it echoes (all at line start, plain text):

| Marker (regex, after ANSI strip)                | Meaning                                                  |
| ----------------------------------------------- | -------------------------------------------------------- |
| `^=== Iteration (\d+)\/(\d+) ===`               | iteration N of M starting                                |
| `^No open issues\. All done!`                   | nothing to do, exiting                                   |
| `^Waiting for other agents`                     | iteration blocked, retrying                              |
| `^All issues resolved after (\d+) iterations\.` | COMPLETE, exiting                                        |
| `^Timeout after (\d+)s`                         | iteration watchdog fired, killed session, loop continues |
| `^Reached max iterations \((\d+)\)`             | exhausted N, exiting                                     |

## Architecture

```
/ralph <path> 10        (Telegram or terminal)
  └─ opens visible terminal (existing launchers) running:
       scripts/ralph-runner.sh <run-dir> <repo> 10
         ├─ writes <run-dir>/meta.json  {pid, startedAt}
         ├─ script -q -F <run-dir>/run.log $RALPH_SCRIPT 10  ← outer `script` gives
         │    (default: sibling scripts/ralph/afk_tasks.sh)     everything a pty AND
         │                                                      mirrors output to run.log
         └─ writes <run-dir>/exit  (exit code)

  bot side:
    src/ralph/store.ts    persisted record (~/.claude-mobile-bridge/ralph.json)
    src/ralph/events.ts   pure log parser (ANSI strip + markers above)
    src/ralph/monitor.ts  tails run.log by offset → posts beats to topic,
                          pid/exit polling, verbose watch attach, finalize
    src/handlers/commands/ralph.ts   command handler
```

Why the nested `script`: we cannot pipe `afk_tasks.sh` stdout through a parser — the inner `script -q … claude` needs a tty and the repo has been burned by this before (see `README_tasks.md` in the ralph dir). An **outer** `script -q -F` preserves the pty chain, still passes output through to the visible terminal, and mirrors everything to `run.log` for the bot to tail. `-F` = flush every write (verified in macOS `man script`).

## Hard-won invariants — read before coding

1. **Ralph topics must NOT go through topic-store/TopicManager.** `TopicManager.reconcile()` (src/topics/topic-manager.ts:226) deletes any stored topic whose sessionName isn't a live session (only `cursor-*` is spared) — a ralph topic would be deleted on every bot restart. Create the forum topic with raw `api.createForumTopic(chatId, name)` and keep `topicId` in the ralph record only.
2. **Unmapped-topic messages fall through to General context.** Typing in the ralph topic would be routed to the _active session_. Add an early guard in `src/handlers/text.ts`: if `message_thread_id` equals the active ralph record's topicId → reply "🔁 loop topic is output-only" and return.
3. **Every claude session registers channel-relay** (user-scoped in `~/.claude.json`), so ralph's ephemeral claudes get port files, appear in `getSessions()`, and — unsuppressed — the watcher would auto-create a topic + broadcast 🟢/🔴 for _each iteration_. `suppressDirNotifications(dir, ms)` (src/sessions/notifications.ts:64) prevents both (the suppressed-add branch skips topic creation). It's time-boxed → the monitor must **re-arm it on every parsed event** (use 10 min windows) and once more at finalize (90s).
4. **`startAutoWatch` aborts if the (chatId,threadId) already has a watch for a different sessionName** (resolveAutoWatchConflict in src/handlers/watch/session-builder.ts). Verbose mode must call `stopWatching(chatId, threadId, api, reason)` (src/handlers/watch/cleanup.ts) **before** attaching the next iteration's session.
5. **Bot restart mid-loop**: startup `reconcile()` will see the currently-alive ralph claude and create a session topic for it. Accept this as a known cosmetic limitation (topic dies at iteration end); do not try to plumb ralph-awareness into reconcile in this pass.
6. Markers must be matched **anchored at line start after ANSI stripping** — claude's TUI redraws can quote prompt text containing similar phrases, but TUI-rendered text is indented/boxed, never at column 0.

## Read these before coding (recon already done — verify, don't re-derive)

| File                                                       | Why                                                                                          |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `~/.claude/scripts/ralph/afk_tasks.sh` + `prompt_tasks.md` | the source to vendor; echo markers; signal-file protocol; `kill_session` pattern to mirror   |
| `src/cron/store.ts`                                        | store pattern to clone (debounce, atomic write, env seam, test reset)                        |
| `src/handlers/commands/cron.ts`                            | command-handler pattern (auth, arg parsing, `busReply`)                                      |
| `src/handlers/commands/spawn.ts`                           | terminal launch + new-session detection pattern (snapshot → poll, memoized realpath)         |
| `src/handlers/commands/terminal-launchers.ts`              | `openMacOSTerminalWithCommand`                                                               |
| `src/sessions/notifications.ts`                            | `suppressDirNotifications` semantics (time-boxed, dir-keyed, also gates topic auto-creation) |
| `src/topics/topic-manager.ts`                              | `reconcile()` — WHY ralph topics must bypass topic-store (invariant 1)                       |
| `src/handlers/watch/session-builder.ts` + `cleanup.ts`     | `startAutoWatch` / `stopWatching` for verbose mode; conflict-abort behavior (invariant 4)    |
| `src/__tests__/commands.test.ts` + `cron-store.test.ts`    | test conventions (grammy mock, env seams)                                                    |

Commands: `bun run typecheck`, `bun run test` (NEVER bare `bun test` — files must run isolated).

## Files to create/modify

### 0. `scripts/ralph/` (new — vendored loop)

Copy `~/.claude/scripts/ralph/afk_tasks.sh` and `~/.claude/scripts/ralph/prompt_tasks.md` into `scripts/ralph/`, applying only the `PROMPT_FILE` change described in "Where the ralph logic lives". Keep everything else byte-identical (the signal-file protocol, watchdog, and echo markers are load-bearing).

### 1. `scripts/ralph-runner.sh` (new, ~15 lines, executable)

```bash
#!/bin/bash
# Usage: ralph-runner.sh <run-dir> <repo-path> [afk_tasks.sh args...]
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
```

Notes: `meta.json` is how the bot learns the pid (it never spawns this directly — the terminal app does). The `exit` file is the completion signal. `RALPH_SCRIPT` comes from the bot's config (step 5 embeds it into the shell command when set). No traps: `/ralph stop` tree-kills from the bot side and `afk_tasks.sh`'s own `trap cleanup EXIT INT TERM` reaps its claude session.

### 2. `src/ralph/store.ts` (new)

Clone the shape of `src/cron/store.ts` (debounced atomic JSON writes, `_reset…ForTesting`, env-var path seam `RALPH_STORE_PATH`, default `join(STATE_DIR, "ralph.json")` — import `STATE_DIR` from `../paths`).

```ts
export interface RalphLoop {
  id: string; // Date.now().toString(36) style
  repoPath: string; // canonical (realpath) absolute path
  iterations: number;
  prMode: boolean;
  label?: string;
  state: "starting" | "running" | "completed" | "stopped" | "ended";
  pid?: number; // wrapper pid, from meta.json
  topicId?: number;
  chatId?: number;
  runDir: string; // <STATE_DIR>/ralph/<id>
  tailOffset: number; // resume point into run.log
  lastIteration?: { n: number; total: number };
  verbose: boolean;
  startedAt: string; // ISO
  endedAt?: string;
  endReason?: string; // "complete" | "max-iterations" | "no-issues" | "stopped" | "exit:<code>" | "process-died"
}
```

Store as `{ loops: RalphLoop[] }`. Exports: `getLoops()`, `getActiveLoop()` (state starting|running), `addLoop()`, `updateLoop(id, patch)`, `removeLoop(id)`, `flush()`. Also a **synchronous** cached accessor `getActiveLoopSync(): RalphLoop | null` for the text-handler guard (keep the cache updated on every mutation; hydrate at bot boot).

`addLoop` must throw/return error if an active loop exists (one-at-a-time). When adding, **prune** any previous non-active loop record and `rm -rf` its `runDir` (log cleanup decision).

### 3. `src/ralph/events.ts` (new, pure — no IO)

```ts
export type RalphEvent =
  | { type: "iteration"; n: number; total: number }
  | { type: "waiting" }
  | { type: "no-issues" }
  | { type: "complete"; iterations: number }
  | { type: "timeout"; seconds: number }
  | { type: "max-iterations"; n: number };

export class RalphLogParser {
  private partial = "";
  /** Feed a raw chunk from run.log; returns newly parsed events. */
  push(chunk: string): RalphEvent[];
}
```

Implementation: append chunk to `partial`; split on `\n`; keep last element as new `partial`. Per line: drop trailing `\r`s, take content **after the last `\r`** (TUI overwrite), strip ANSI CSI (`/\x1b\[[0-9;?]*[ -\/]*[@-~]/g`) and OSC (`/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g`) sequences, then test the six anchored regexes from the table above. Non-matching lines are dropped.

### 4. `src/ralph/monitor.ts` (new)

```ts
export function startRalphMonitor(api: Api, loop: RalphLoop): void;
export function stopRalphMonitor(): void; // clears interval only
export async function stopRalphLoop(api: Api): Promise<boolean>; // tree-kill + finalize
export async function recoverRalphOnBoot(api: Api): Promise<void>;
export function setRalphVerbose(api: Api, on: boolean): Promise<void>;
```

**Tick loop** (setInterval ~1500 ms):

- Read new bytes from `<runDir>/run.log` starting at `tailOffset` (fs `open`/`read`, handle file-not-yet-created), feed to a `RalphLogParser` instance, bump + persist `tailOffset` (debounced via store).
- Handle events (below).
- Check `<runDir>/exit` and pid liveness (`process.kill(pid, 0)` throws → `process-died`, message "terminal closed?"). On either: **drain the rest of run.log through the parser first** (a terminal marker in the final chunk sets the real reason), then finalize with `exit:<code>` only if no marker claimed it.

**Event handling** (post via `getMessageBus().send({chatId, threadId: topicId, content, format: "html"})`):

- `iteration` → re-arm `suppressDirNotifications(repoPath, 600_000)`; update `lastIteration`; enrich **best-effort** with `gh issue list --state open [-l label] --json number,title` run in `repoPath` (Bun.spawn, 5 s timeout, silent failure) → post `🔄 iter N/M · X issues open · next: #nn <title>`; if `verbose` → re-attach watch (below).
- `waiting` → `⏸ WAITING — blocked tasks, loop will retry`
- `timeout` → `⏱ iteration timed out after Ns — session killed, continuing`
- `no-issues` → finalize reason `no-issues`, `🏁 no open issues — nothing to do`
- `complete` → finalize reason `complete`, `🏁 COMPLETE after N iterations`
- `max-iterations` → finalize reason `max-iterations`, `⚠️ reached max iterations (N) — issues may remain open`

**Verbose watch attach** (per iteration, async, non-blocking):

1. `stopWatching(chatId, topicId, api, "ralph-iter")` if a watch exists on that thread.
2. Snapshot current session ids/pids in `repoPath` (canonicalize dirs like spawn.ts does — memoized `tryRealpathSync`).
3. Poll `forceRefresh()` + `getSessions()` every 2 s (up to 90 s) for a session in `repoPath` not in the snapshot.
4. Found → `startAutoWatch(api, chatId, topicId, session.name)`. Not found → log, skip (next iteration retries).
   Toggling verbose **off** mid-loop → `stopWatching` immediately. Toggling **on** → attempt attach to the newest session in the dir right away.

**stopRalphLoop** (tree kill, mirrors `kill_session` in afk_tasks.sh): recurse `pgrep -P <pid>` from the wrapper pid to collect the tree (pure helper `collectTree(rootPid, pgrepFn)` for tests), `kill -TERM` all, 2 s grace, `kill -KILL` survivors. Then finalize reason `stopped` → `🛑 stopped at iter N/M`.

**Finalize** (single idempotent path): clear interval, `stopWatching` any ralph-thread watch, update record (`state`, `endedAt`, `endReason`), `suppressDirNotifications(repoPath, 90_000)` once more, post the final beat, and post a one-line summary (`gh issue list` count, best-effort).

**recoverRalphOnBoot**: active record + pid alive → re-arm suppression, `startRalphMonitor` (resumes from `tailOffset`). Pid dead → drain remaining log through the parser to find the true end state, finalize with `⚠️ loop ended while bridge was offline — <reason>`.

### 5. `src/handlers/commands/ralph.ts` (new)

Follow `handleCron`'s structure (auth via `isAuthorized(userId, ALLOWED_USERS)`, `busReply` from `./helpers`, raw-arg parsing).

```
/ralph                       → status (active loop: repo, iter, uptime, verbose flag; else usage)
/ralph <path> [N] [-pr] [-l <label>]  → start (N defaults to 10)
/ralph stop                  → stopRalphLoop
/ralph verbose on|off        → setRalphVerbose
```

**Start flow**:

1. Reject if `getActiveLoop()` exists → `❌ loop already running on <repo> — /ralph stop first`.
2. Expand `~`, `tryRealpathSync`, verify dir exists and `git -C <path> rev-parse --git-dir` succeeds (reject otherwise). `gh` reachability is NOT pre-checked (afk_tasks surfaces it in-terminal).
3. `addLoop` (state `starting`), create topic: `api.createForumTopic(chatId, "🔁 ralph " + basename(repo))` — chatId from `getTopicManager()?.getChatId() ?? ctx.chat.id`. Store topicId/chatId on the record. If topic creation fails, fall back to posting beats to the invoking chat/thread.
4. `suppressDirNotifications(repo, 600_000)`.
5. Build shell command — reuse `bashSingleQuotedPath` (from `./helpers`) for every path/arg:
   `[RALPH_SCRIPT=<quoted> ][RALPH_PROMPT=<quoted> ]exec <abs repo scripts/ralph-runner.sh> <runDir> <repo> [-pr] [-l <label>] <N>`
   (env prefixes only for overrides actually set in config; runner script path: resolve relative to the bot's own repo — `new URL("../../../scripts/ralph-runner.sh", import.meta.url).pathname` or equivalent; verify it exists and is executable, `chmod +x` in repo).
6. `openMacOSTerminalWithCommand(shellCmd, repo)` (from `./terminal-launchers`). On failure: remove record, report.
7. Poll for `<runDir>/meta.json` (every 1 s, 30 s deadline). Found → parse pid, `updateLoop({pid, state: "running"})`, `startRalphMonitor`, post `▶️ loop started — <repo> · N iterations · <direct|PR> mode` to the topic and ack in the invoking context. Timeout → mark `ended`/`endReason: "spawn-failed"`, report ❌.

### 6. Wiring (modify)

- `src/config.ts` + `.env.example`: optional `RALPH_SCRIPT` (alternative loop script; empty = vendored `scripts/ralph/afk_tasks.sh`) and `RALPH_PROMPT` (alternative prompt file; empty = vendored `scripts/ralph/prompt_tasks.md`).
- `src/bot.ts`: import + `bot.command("ralph", handleRalph)` next to the others (no `withSctx` needed; handler reads ctx directly).
- `src/handlers/commands/index.ts`: export `handleRalph` (match existing export style).
- `src/handlers/text.ts`: early guard (invariant 2) — before topic routing, `const rl = getActiveLoopSync(); if (rl?.topicId && ctx.message?.message_thread_id === rl.topicId) { reply nudge; return; }`.
- Bot startup (where cron's `startCronScheduler` is wired — `src/index.ts` or `src/lifecycle.ts`): call `recoverRalphOnBoot(api)`; on shutdown call `stopRalphMonitor()` + store `flush()`.
- `/help` text (wherever `handleHelp` lists commands): add `/ralph`.

### 7. Tests (`src/__tests__/`, run with `bun run test` — NEVER bare `bun test`)

- `ralph-events.test.ts` — parser: each marker; ANSI-wrapped marker lines; `\r`-overwritten lines; chunk split mid-line (partial buffering); indented lookalike text does NOT match; multi-event chunk ordering.
- `ralph-store.test.ts` — CRUD via `RALPH_STORE_PATH` tmp seam; `addLoop` rejects when active loop exists; prune-on-add removes old record; `getActiveLoopSync` cache coherence.
- `ralph-kill.test.ts` — `collectTree` pure function with fake pgrep outputs (root only, deep tree, missing pids).
- `ralph-command.test.ts` — arg parsing (default 10 iters, `-pr`, `-l x`, `~` expansion), unauthorized, already-running rejection, `stop` with nothing running. Use the existing grammy mock conventions (see `src/__tests__/commands.test.ts`).
- `ralph-recovery.test.ts` — dead pid + log containing `All issues resolved after 3 iterations.` past the stored offset → finalized `complete`.

Keep `monitor.ts`'s IO thin so logic lives in testable pure helpers (parser, tree collection, event→message formatting).

### 8. Docs

- `CLAUDE.md`: one line under Patterns (`**Ralph loops**: /ralph runs afk_tasks.sh in a terminal; src/ralph/ tails its log — topic is NOT in topic-store`).
- `docs/ralph-loops.md`: short user doc (commands, what the topic shows, verbose mode, limitations: output-only topic, restart-mid-loop cosmetic topic, hard-kill stop may leave a dirty branch).

## Manual verification (after typecheck + tests pass)

1. In a scratch repo with 1–2 open test issues: `/ralph <path> 2` from Telegram General → terminal opens, topic appears, `▶️` + `🔄 iter 1/2` beats arrive.
2. `/ralph` → status shows running.
3. `/ralph verbose on` → transcript streams into the topic; `off` stops it.
4. `/ralph stop` mid-iteration → processes gone (`pgrep -f afk_tasks.sh` empty), `🛑` posted.
5. Start again, kill the bot mid-loop, restart bot → beats resume; then close the terminal window → `⚠️ loop ended` posted.
6. Confirm no 🟢/🔴 session broadcasts or stray auto-created topics during a loop.

## Decisions already made (do not re-ask)

- Only `afk_tasks.sh` (not `once.sh`/docker). Issue-driven; no markdown task lists.
- Visible terminal via existing launcher setting. One loop at a time. Iterations default 10.
- `/ralph stop` = hard tree-kill mid-iteration (dirty branch acceptable).
- Typed path only (no folder picker). Old run logs deleted when the next loop starts.
- Verbose defaults off; toggleable mid-loop.
- Loop logic vendored at `scripts/ralph/` (portable for all users); `RALPH_SCRIPT` env override for personal copies. Global `~/.claude/scripts/ralph/*` untouched.

## Unresolved questions

None.
