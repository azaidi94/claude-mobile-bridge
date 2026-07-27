# Ralph loops — `/ralph`

Start, watch, and stop a [ralph loop](https://ghuntley.com/ralph/) (`afk_tasks.sh`)
from Telegram. The loop runs in a visible desktop terminal on the bot host; a
dedicated forum topic shows distilled per-iteration beats, with an optional
full-transcript verbose mode.

One loop runs at a time.

## Commands

| Command                                | Effect                                                              |
| -------------------------------------- | ------------------------------------------------------------------- |
| `/ralph <path> [N] [-pr] [-l <label>]` | Start a loop on `<path>` for `N` iterations (default 10).           |
| `/ralph`                               | Status of the running loop (repo, iteration, uptime, verbose flag). |
| `/ralph stop`                          | Hard tree-kill the loop mid-iteration and finalize.                 |
| `/ralph verbose on\|off`               | Stream / stop streaming the full session transcript into the topic. |

Flags:

- `-pr` — PR mode (the loop opens PRs instead of squash-merging to the base branch).
- `-l <label>` — only work issues carrying the given GitHub label. Defaults to the
  `Ralph label` setting in `/settings` (blank ⇒ no filter, i.e. all open issues).
  `-l -` forces no filter for one run even when a default is set.
- Relative `<path>` resolves against the `Working dir` setting (like `/new`); `~` is
  expanded. The path must be an existing **git repo** on the bot host.

## What the topic shows

Each loop gets a forum topic named `🔁 ralph <repo>`. Beats posted there:

- `▶️ loop started` — repo, iteration count, direct/PR mode.
- `🔄 iter N/M · X issues open · next: #nn <title>` — one per iteration (issue counts are best-effort via `gh`).
- `⏸ WAITING` — an iteration was blocked; the loop will retry.
- `⏱ iteration timed out` — the per-iteration watchdog killed the session; the loop continues.
- Terminal beats: `🏁 COMPLETE`, `🏁 no open issues`, `⚠️ reached max iterations`, `🛑 stopped`, or a plain exit line.

**The topic is output-only** — messages you send there are not routed anywhere
(you'll get a nudge). Control the loop with the `/ralph …` commands from any chat.

### Verbose mode

`/ralph verbose on` attaches a live watch to each iteration's Claude session so
its full transcript streams into the topic; `off` detaches it. It defaults off
and can be toggled at any time during a run.

## Customizing the loop

| Want                        | How                                                              |
| --------------------------- | ---------------------------------------------------------------- |
| Custom prompt for one repo  | Add `plans/prompt_tasks.md` to that repo (wins over everything). |
| Custom prompt everywhere    | Set `RALPH_PROMPT=/path/to/prompt.md` in `.env`.                 |
| Entirely custom loop script | Set `RALPH_SCRIPT=/path/to/script.sh` in `.env`.                 |
| Longer per-iteration limit  | Set `RALPH_TIMEOUT=<seconds>` in `.env` (default 7200).          |

### The per-iteration watchdog

`claude` runs interactively here, so it doesn't exit when a turn ends — it sits
at the prompt. A background watchdog is what ends each iteration: it polls for
the model's `$RALPH_SIGNAL` file and kills the session (and its whole process
tree) the moment one appears. `RALPH_TIMEOUT` is only its **fallback** for a
session that never signals — hung on a prompt, crashed TUI, or a model that
finished the work but never echoed. It is not a per-task budget.

A timeout kill is visible as a `⏱ iteration timed out after Ns` beat, and it
costs you that iteration's uncommitted work (in the `tasks.md` loop the task
stays unflipped and is re-served from scratch). So if large tasks are getting
killed mid-flight, raise it. Lowering it below what your tasks genuinely need
just burns iterations.

The loop logic is **vendored** at `scripts/ralph/afk_tasks.sh` +
`scripts/ralph/prompt_tasks.md`, so every clone has a working default. Rich beats
come from the vendored script's echo markers; a custom `RALPH_SCRIPT` only gets
them by emitting the same lines, but missing markers degrade gracefully (start /
finish / stop beats still work, and verbose streaming is marker-independent).

## Running without GitHub

The default loop reads GitHub issues. To run on a repo with no GitHub, drive the
loop from a local `plans/tasks.md` instead:

1. Set `RALPH_SCRIPT=/abs/path/to/scripts/ralph/afk_tasks_md.sh` in `.env`.
2. Create `plans/tasks.md` — either by hand or with the `plan-tasks` skill
   (`/plan-tasks [<repo-path>] <goal>`), which decomposes a goal into a
   well-shaped queue for you to review.
3. Run `/ralph <repo> [N]` as usual. Each iteration drains the next eligible
   `[ ]` item; the loop finishes when all items are `[x]`.

Format (`plans/tasks.md`):

```markdown
# Plan: <goal>

## [ ] 1. <title>

**Acceptance:** <done condition>
**Depends on:** none
**Context:** <pointers>
```

The outer script owns the checkboxes (it flips `[ ]`→`[x]` when a session signals
`DONE`); you own the file between runs (reorder, edit acceptance, re-open a task
by flipping `[x]`→`[ ]`).

The header line is parsed strictly — exactly `## [ ] N. Title`. The loop aborts
on a header that's close but wrong (`1:` for `1.`, `[X]`, indentation) rather
than run: a file that parses to zero items would otherwise look like a finished
queue and exit "all resolved" having done nothing.

Limitations in this mode:

- `-pr` needs `gh`, so it's **direct-merge only** (the script warns and
  proceeds); `-l <label>` is ignored.
- **Named branch required** — each task merges into the branch the loop started
  on, so a detached HEAD aborts before iteration 1.
- **Malformed queue aborts** — a broken header or an unflippable checkbox exits
  non-zero instead of spinning on the same task.

## Limitations

- **Output-only topic** — you can't chat into the loop topic.
- **Restart mid-loop** — if the bot restarts while a loop is running, startup
  reconcile may create a transient session topic for the currently-alive
  iteration claude; it disappears at iteration end. Cosmetic only. The loop's own
  beat topic resumes correctly.
- **`/ralph stop` is a hard kill** — it tree-kills mid-iteration, so the working
  tree / branch may be left dirty.
- **macOS only** — the loop needs a desktop terminal on the bot host.
