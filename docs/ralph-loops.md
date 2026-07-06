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

The loop logic is **vendored** at `scripts/ralph/afk_tasks.sh` +
`scripts/ralph/prompt_tasks.md`, so every clone has a working default. Rich beats
come from the vendored script's echo markers; a custom `RALPH_SCRIPT` only gets
them by emitting the same lines, but missing markers degrade gracefully (start /
finish / stop beats still work, and verbose streaming is marker-independent).

## Limitations

- **Output-only topic** — you can't chat into the loop topic.
- **Restart mid-loop** — if the bot restarts while a loop is running, startup
  reconcile may create a transient session topic for the currently-alive
  iteration claude; it disappears at iteration end. Cosmetic only. The loop's own
  beat topic resumes correctly.
- **`/ralph stop` is a hard kill** — it tree-kills mid-iteration, so the working
  tree / branch may be left dirty.
- **macOS only** — the loop needs a desktop terminal on the bot host.
