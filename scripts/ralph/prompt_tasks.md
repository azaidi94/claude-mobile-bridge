# ONE ISSUE PER SESSION

You handle exactly ONE issue, then signal done and end your turn. The outer script restarts you for the next issue. Never work on more than one issue.

To signal, write a single status word to the file at `$RALPH_SIGNAL`, then stop producing output. The outer script detects it and terminates this session — do NOT run any `kill` yourself.

---

# ISSUES

Issues JSON provided at start of context. Pick the **first open issue** (lowest number, respecting blocked-by). Ignore the rest — they're for future sessions.

If no open issues: run `echo COMPLETE > "$RALPH_SIGNAL"` then **stop**.

# TASK SETUP

1. Call TaskList
2. If tasks exist for current issue, skip to CLAIM TASK
3. Otherwise, create tasks **for your one issue only**:
   - **Simple issue** (single clear action): 1 task
   - **Complex issue** (multiple steps): subtasks with dependencies

## Task Format

- Subject: `Issue #<issue>.<seq>: <description>` (e.g., `Issue #3.1: Investigate auth`)
- Store issue number in metadata: `{ "issue": 3 }`
- Use `addBlockedBy` for dependencies between tasks

Example:

```
Issue #3 "Add JWT auth" →
  Task 1 "Issue #3.1: Investigate current auth"
  Task 2 "Issue #3.2: Implement JWT auth" (blockedBy: Task 1)
  Task 3 "Issue #3.3: Write tests" (blockedBy: Task 2)
```

# CLAIM TASK

1. Call TaskList
2. Find task: status=pending, no owner, not blocked, matching your issue
3. Claim it: `TaskUpdate(taskId=<id>, owner="ralph", status="in_progress")`
4. If no claimable tasks:
   - All completed → proceed to FINALIZE ISSUE
   - Some blocked → run `echo WAITING > "$RALPH_SIGNAL"` then **stop**

# BRANCH

Note current branch as BASE_BRANCH, then create issue branch (if not already on one):

```bash
BASE_BRANCH=$(git branch --show-current)
git checkout -b <number>-<slug>
```

All tasks for the same issue share one branch.

# DO THE WORK

1. `gh issue view <number>` — read requirements
2. Explore repo, find relevant files
3. Implement the task
4. Run feedback loops (lint, typecheck, test) — fix failures
5. Check issue's Acceptance section for `/commands` — run any skills found
6. Stage changes: `git add <files>` (do NOT commit yet)
7. Mark complete: `TaskUpdate(taskId=<id>, status="completed")`

Then check TaskList for your issue:

- More tasks remaining → go to CLAIM TASK
- All tasks completed → run final checks, then continue to FINALIZE ISSUE

```bash
bun run lint && bun run type-check && bun run test
```

# FINALIZE ISSUE

Commit, merge/PR, close, and signal done. Run all commands without stopping.

```bash
git add -A && git commit -m "feat(#<issue>): <short description>"
```

**Direct mode:**

```bash
git checkout $BASE_BRANCH && git merge --squash <branch>
git commit -m "feat(#<issue>): <description>

Closes #<issue-number>"
git branch -D <branch>
gh issue close <number>
echo DONE > "$RALPH_SIGNAL"
```

**PR mode:**

```bash
git push -u origin <branch>
gh pr create --title "<title>" --body "Closes #<number>"
echo DONE > "$RALPH_SIGNAL"
```

**After writing the signal, your session ends here. Stop. Do not continue or run any `kill`.**
