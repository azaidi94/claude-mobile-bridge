# ONE TASK PER ITERATION — UNATTENDED ac-pipeline

You run exactly ONE task through the **ac-pipeline** skill in **unattended**
mode, then signal and end your turn. The outer ralph loop restarts you for
the next task. Never work on more than one task per session.

To signal, write a single status word to the file at `$RALPH_SIGNAL`, then
stop producing output. The outer script detects it and terminates this
session — do NOT run any `kill` yourself.

- `DONE` — the task reached the bindings' Ship policy terminus (shipped,
  skipped-and-reported, or QA-cap-exhausted-and-moved-on — see below), and
  any bookkeeping (task-file checkbox, tracker comment) is committed.
- `WAITING` — no eligible task was found this iteration but more may appear
  later (e.g. a tracker query failed transiently); the loop will retry.
- `COMPLETE` — no open task exists anywhere the intake step checks; the
  queue is empty. Stop entirely.

# STEP 1 — Intake

Read `.claude/ac-bindings.md`. If it's missing, `echo WAITING >
"$RALPH_SIGNAL"` and stop — this repo isn't installed correctly.

Find the next task per the bindings' **Tracker**:

- **jira** — use the `jira` MCP tools' `jira_search` for issues assigned to
  the current user and open; take the first result.
- **github** — `gh issue list --assignee @me --state open --limit 1`; take
  that issue.
- **none** — open `plans/tasks.md` and take the first unchecked (`- [ ]`)
  entry.

If none found in any case: `echo COMPLETE > "$RALPH_SIGNAL"` then **stop**.

# STEP 2 — Run the pipeline

Invoke the **ac-pipeline** skill on the task, explicitly in **unattended**
mode (state this in your own instructions to yourself — the skill only
runs unattended when told to). The skill reads `.claude/ac-bindings.md` for
tracker, base branch, and ship policy, so don't re-derive those yourself.

Unattended mode's hard rules apply — restate them to yourself before
starting:

1. Ambiguous task → skip it, write why in your one-line result below, and
   move on. Never guess at intent.
2. QA cap (3 rounds) reached → leave the branch and findings in place and
   move on. Don't keep looping past the cap.
3. Terminus is the bindings' Ship policy — stop there, don't invent further
   steps (no opening follow-up work, no extra polish passes).
4. The bindings' Done-transition is **never** performed unattended, no
   matter how clean the result looks — leave that for a human.

# STEP 3 — Report and signal

1. If the tracker is **none**, tick the task's checkbox in `plans/tasks.md`
   and commit that change alongside (or right after) the task's own
   commits — the outer loop doesn't own this file for the unattended
   ac-pipeline flow, you do.
2. Echo one line summarizing the outcome, e.g.:
   - `shipped TASK-123: <one-line summary>`
   - `skipped TASK-123: ambiguous — <why>`
   - `qa-cap TASK-123: 2 blockers unresolved after 3 rounds, left on branch <name>`
3. Write the appropriate signal (`DONE`, `WAITING`, or `COMPLETE` per the
   rules above) to `$RALPH_SIGNAL` and stop. Do not continue past the
   signal write.

<!-- ac-pipeline-version: 1 -->
