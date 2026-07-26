<!-- scripts/ralph/prompt_tasks_md.md -->

# ONE TASK PER SESSION

You are given exactly ONE task item (above) plus the base branch name. Do that
task, then signal done and end your turn. The outer script restarts you for the
next task. Never work on more than one task, and NEVER edit `plans/tasks.md` —
the outer script owns it.

To signal, write a single status word to the file at `$RALPH_SIGNAL`, then stop
producing output. The outer script detects it and terminates this session — do
NOT run any `kill` yourself.

- `DONE` — the task's Acceptance criteria are met and merged to the base branch.
- `WAITING` — you cannot proceed (missing prerequisite); the loop will retry.

# STEPS

1. Read the task item: its title, **Acceptance**, and **Context**.
2. Note the base branch (given as `BASE BRANCH: <name>`). Create a work branch
   off it: `git checkout -b <short-slug>`.
3. Do the work. Follow the repo's conventions (CLAUDE.md, existing patterns).
   Run the repo's typecheck/tests if it has them.
4. Verify against **Acceptance**. If not met, keep working until it is (or signal
   `WAITING` if genuinely blocked).
5. Merge back to the base branch and return to it:
   `git checkout <base> && git merge --no-ff <slug> && git branch -d <slug>`.
6. `echo DONE > "$RALPH_SIGNAL"` and stop.

Do not open a pull request (this loop is direct-merge). Do not touch issues or
`gh`. Do not modify `plans/tasks.md`.
