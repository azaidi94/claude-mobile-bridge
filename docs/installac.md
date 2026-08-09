# AC pipeline install — `/installAC`

Vendor the AC pipeline skills (Auto Claude-style plan/code/QA rigor, generic
enough for any project) into a target repo, with a short Q&A that captures
the project's tracker, branching, and ship policy in a small bindings file.

## Commands

| Command             | Effect                                                                         |
| ------------------- | ------------------------------------------------------------------------------ |
| `/installac <path>` | Install (or upgrade) the AC pipeline skills in `<path>`; starts the Q&A below. |

`<path>` resolves like `/ralph`'s and `/new`'s: relative paths resolve against
the `Working dir` setting, `~` is expanded, and the target must already be a
git repo — the command rejects anything else before asking a single question.

### The four questions

Answered via inline keyboard buttons, one at a time, in order:

1. **Which issue tracker?** `Jira` · `GitHub` · `None`
   Determines how `/ac` and `/ac-investigate` find and read tasks: Jira MCP
   tools, `gh issue`, or (for `None`) a plain described goal with a slugified
   task id.
2. **Base branch?** `main` · `develop` · `master`
   The branch the pipeline always fetches and branches from
   (`git fetch origin` then branch off `origin/<base>`).
3. **Ship policy?** `PR` · `Push only` · `Direct merge`
   Where a finished task's changes end up — this is also the pipeline's
   unattended terminus (see below).
4. **Install the ralph prompt (`plans/prompt_tasks.md`)?** `Yes` · `No`
   Whether to also write the unattended-mode ralph prompt (see
   [Ralph integration](#ralph-integration)).

Each answer edits the same message in place, showing a running checklist of
answers above the next question. After the fourth answer, the bot installs
and reports a summary (version, file count, bindings status, ralph status,
commit status).

## What gets installed

Under `<repo>/.claude/`:

- **4 skills** (`skills/<name>/SKILL.md`):
  - `ac-pipeline` — the adaptive pipeline behind `/ac`: complexity
    assessment, optional mini-spec, planning, implementation, QA loop, ship.
  - `ac-review` — PR/MR review against the project's standards; findings
    shown in-session, comments posted only on explicit approval.
  - `ac-investigate` — pre-work triage: root-cause hypothesis with code
    evidence, affected components, and fix scope.
  - `ac-ideate` — scans an area for security, performance, and code-quality
    improvements, pre-shaped as tracker tickets.
- **4 commands** (`commands/<name>.md`): `/ac <task>`, `/ac-review <PR/MR>`,
  `/ac-investigate <ticket>`, `/ac-ideate <area>` — these are Claude Code
  slash commands available in any session opened on the installed repo, not
  bot commands.
- **`ac-bindings.md`** — generated from the four answers (see below).
- **`plans/prompt_tasks.md`** (optional) — only if you answered "Yes" to
  question 4; the unattended ralph prompt.

The installer also appends `.acp/` to the repo's `.gitignore` (idempotent —
skipped if already present). `.acp/<task-id>/` is where the pipeline keeps
its working artifacts (plan.md, QA notes) per task.

## The bindings file

`.claude/ac-bindings.md` is generated once from your answers and never
overwritten by a later `/installAC` run — **edit it freely by hand**. All
four skills read it before doing anything tracker- or ship-specific; none of
them hardcode a tracker name.

| Field               | Options                                                                                | Meaning                                                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Tracker**         | `jira` \| `github` \| `none`                                                           | `jira`: intake via the `jira` MCP tools (`jira_get_issue`, `jira_search`) — the project must have that server registered. `github`: intake via `gh issue view/list`. `none`: `/ac` takes a described goal directly; the task id is a slug. |
| **Base branch**     | any branch name                                                                        | Always `git fetch origin` then branch from `origin/<base branch>`.                                                                                                                                                                         |
| **Ship policy**     | `pr` \| `push-only` \| `direct-merge`                                                  | Where a finished task's changes land. Also the unattended pipeline's terminus — it stops here, it doesn't invent further steps.                                                                                                            |
| **Done-transition** | derived from Tracker (`jira`: tracker transition; `github`: close issue; `none`: none) | What marks a task fully done beyond shipping (a Jira transition, closing the issue). Attended-only, **never** performed unattended, no matter how clean the result looks.                                                                  |
| **Standards docs**  | free text, left blank by the installer                                                 | Optional paths the plan/QA/review phases should read; fill in by hand if the project has a style guide, architecture doc, etc.                                                                                                             |

If `ac-bindings.md` is missing, the skills stop and tell you to run
`/installAC` — or you can write one by hand, it's just markdown following
the same fields.

## Upgrade behavior

Every template file carries a version stamp
(`<!-- ac-pipeline-version: N -->`). Re-running `/installAC` on an
already-installed repo:

- **Overwrites** `skills/` and `commands/` — they're vendored, not
  user-owned, so the newer templates always win.
- **Preserves** `ac-bindings.md` — if one already exists, the installer
  leaves it untouched and the summary reports "bindings preserved
  (already present)" instead of writing a fresh one. Delete it by hand first
  if you actually want to redo the Q&A.
- Reports old → new version in the install summary (or "already up to
  date" if nothing changed).

Answering "Yes" to the ralph-prompt question on an upgrade run overwrites
`plans/prompt_tasks.md` with the current template; "No" leaves an existing
one untouched.

## Attended vs. unattended operation

- **Attended** is the default for any interactive session, including bridge
  (Telegram/desktop) sessions run via `/ac`, `/ac-review`, etc. by hand. The
  pipeline asks at gates: ambiguity, plan approval, posting externally, and
  ship.
- **Unattended** only runs when the invoking prompt explicitly says so — in
  practice, only the installed ralph prompt does this. Four hard rules apply
  and are restated in the prompt itself before each task:
  1. An ambiguous task is skipped and reported, never guessed at.
  2. Hitting the QA cap (3 rounds) leaves the branch and findings in place
     and moves on — it doesn't keep looping past the cap.
  3. The terminus is the bindings' Ship policy — it stops there, it doesn't
     invent further steps (no follow-up work, no extra polish passes).
  4. The bindings' Done-transition is **never** performed unattended,
     regardless of how clean the result looks — that's always left for a
     human.
- The done-transition step is never automatic in either mode's terminus
  logic — attended mode still asks before performing it; unattended mode
  never performs it at all.

## Ralph integration

If you installed the ralph prompt (question 4 = Yes), `/ralph <repo>` needs
no extra configuration: it already prefers a repo's `plans/prompt_tasks.md`
over the bundled default, so the installed prompt is picked up automatically.
Each ralph iteration reads `.claude/ac-bindings.md`, finds the next eligible
task per the bindings' tracker (Jira query, `gh issue list --assignee @me`,
or the next unchecked `## [ ] N. Title` in `plans/tasks.md` for `none`), runs
the `ac-pipeline` skill on it in unattended mode, and signals `DONE`,
`WAITING`, or `COMPLETE` for the outer loop. See
[Ralph loops](ralph-loops.md) for `/ralph`'s own commands, beats, and
customization options — none of that changes here.

## Safety notes

- The installer only ever writes inside the repo path you name — no network
  actions, no writes outside the target repo.
- The install/upgrade commit runs `git commit --no-verify`: foreign repos
  may have their own hooks that aren't ours to run on the user's behalf, so
  the installer skips them rather than risk a hook failure blocking the
  install. The exact commit message is `Install AC pipeline skills
(ac-pipeline v<N>) via /installAC`, with `<N>` the current template
  version (e.g. `ac-pipeline v1`).
- `ac-bindings.md` never contains credentials — tracker access rides on
  whatever MCP servers or CLIs (`jira`, `gh`) the target project already has
  configured; the installer doesn't ask for or store any secrets.
