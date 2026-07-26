---
description: Decompose a freeform goal into a well-shaped plans/tasks.md queue for a ralph loop (GitHub-free). Invoke as /plan-tasks [<repo-path>] <goal>.
allowed-tools: Bash, Read, Glob, Grep, Edit, Write
---

## Plan Tasks

Turn a freeform **goal** into a reviewable `plans/tasks.md` that a GitHub-free
ralph loop drains one item per iteration. Write the draft and STOP — never start
ralph, never run the loop.

### Interface

`/plan-tasks [<repo-path>] <goal>`

- No path → plan the repo of the current session (its working directory).
- With path → plan the repo at `<repo-path>` (expand `~`, resolve relative to
  the working dir). `cd` there before exploring/writing.

### Steps

1. **Explore the target repo first.** Read structure, conventions (CLAUDE.md /
   AGENTS.md), and how tests run, so tasks reference real files and commands.
2. **Decompose the goal into iteration-sized items.** Each item = one coherent
   change a _cold_ session can finish on one branch, with a testable outcome.
   Split items that span unrelated areas or can't be verified in one pass; merge
   items too trivial for their own iteration.
3. **Order with dependencies.** Put foundational work first; express ordering as
   `Depends on:` links (investigate → implement → test), not prose.
4. **Make each item self-contained.** Its `Acceptance` + `Context` must let a
   session with zero memory of the plan finish it. Rich but scaled: a trivial
   item gets one line of acceptance, a complex one gets several. No open-ended
   items ("keep refactoring") — every item needs a finish line or the loop never
   completes.
5. **Write** `plans/tasks.md` in the target repo, in exactly this format:

   ```markdown
   # Plan: <goal restated>

   ## [ ] 1. <imperative title>

   **Acceptance:** <how a cold session knows it's done>
   **Depends on:** none
   **Context:** <files, prior art>

   ## [ ] 2. <title>

   **Acceptance:** ...
   **Depends on:** 1
   ```

   Number items from 1, sequentially. The header line must match exactly
   `## [ ] N. Title` — the loop's parser is strict, and a slip (`1:` for `1.`,
   indentation, a missing space in `[ ]`) aborts the run. `Depends on:` is
   `none` or a comma-list of earlier item numbers.

6. **Self-check the draft** before finishing: no dependency cycles, no vague
   acceptance criteria, no oversized items, no duplicates. Fix inline.
7. **Hand off.** Tell the user the draft is written for review and that they can
   edit it, then run `/ralph <repo>` (with the tasks.md `RALPH_SCRIPT`
   configured). Do not run anything yourself.
