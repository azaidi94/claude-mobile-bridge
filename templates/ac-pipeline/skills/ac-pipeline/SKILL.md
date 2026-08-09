---
name: ac-pipeline
description: Use when running a task end-to-end via /ac — an adaptive pipeline (complexity assessment, optional mini-spec, planning, implementation, QA loop, ship) that brings Auto Claude's plan/code/validate rigor into an in-session workflow for any project.
---

# ac-pipeline

Run a task through an adaptive, Auto Claude-style pipeline in this session.
Depth adapts to task complexity. All artifacts are **markdown** under
`.acp/<task-id>/` (gitignored) so a later session can inspect or resume the
work.

Project specifics (tracker, base branch, ship policy, standards docs) live
in **`.claude/ac-bindings.md`**. If that file is missing, stop and tell the
user to run `/installAC` (or write one by hand — it's just markdown).

## Phase 0 — Intake

1. Read `.claude/ac-bindings.md`. If missing, stop with: "run /installAC" (or
   write `.claude/ac-bindings.md` by hand) — don't guess at project
   conventions.
2. Intake the task per the bindings' Tracker:
   - **jira**: use the project's `jira` MCP tools to fetch the ticket,
     including comments. Confirm you understand the full requirement.
   - **github**: `gh issue view <number>` for the full issue, including
     comments.
   - **none**: the task is the goal described in the invoking prompt/command
     argument — no external fetch.
3. `git fetch origin`, then branch from `origin/<base>` per the bindings'
   Base branch.
4. Determine the task id: the ticket/issue key when a tracker exists, else a
   kebab-case slug of the goal. Create `.acp/<task-id>/` and write the
   initial Status header (format below).

## Phase 1 — Complexity assessment

Classify the task using this rubric, and record the classification plus a
one-line justification in the Status header:

| Class       | Criteria                                                                    | Pipeline                                                                   |
| ----------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **simple**  | Single repo, ≤ 2 files expected, unambiguous requirement, no new components | Skip straight to Phase 3. No plan file — Status header only (`status.md`). |
| **medium**  | Single repo, several files or one new component, requirements clear         | Phases 2 → 3 → 4                                                           |
| **complex** | Multiple repos, ambiguous requirements, new subsystem, or data-model change | Phase 1b, then 2 → 3 → 4                                                   |

When in doubt between two classes, pick the heavier one — an unnecessary
plan is cheaper than an unplanned mess.

## Phase 1b — Mini-spec (complex only)

Write `.acp/<task-id>/spec.md` — one document, no subagents:

- **Problem** — what the task actually asks for, incl. what's ambiguous and
  how you resolved it (ask the user if genuinely unclear — see Operating
  modes below).
- **Approach** — chosen design in a few paragraphs; alternatives rejected.
- **Acceptance criteria** — a testable checklist. This is the contract the
  QA phase validates against; make each item concretely verifiable.
- **Out of scope** — what this task deliberately does not change.

In attended mode, a complex+ambiguous task may run a one-question-at-a-time
clarification loop with the user before writing spec.md (see Inherited
guidance). Unattended mode never does this — ambiguity means skip and
report, not guess.

## Phase 2 — Planning

Dispatch a **Plan subagent** (read-only) whose prompt contains:

- The task summary + description (and spec.md content, if written).
- The bindings' Standards docs, if listed — the area(s) the plan touches.
- Required output shape: a subtask breakdown where every subtask is a
  `- [ ]` checkbox with (a) files to touch, (b) what to change, and (c) a
  concrete verification step (a test to run or behavior to check).

Write the result into `plan.md` beneath the Status header. Review it
yourself before implementing — reject plans with vague subtasks ("update
the service") or missing verification steps and re-dispatch. Hold the plan
to the quality bar in Inherited guidance below.

## Phase 3 — Implementation

Work subtask by subtask in this session:

- Read the bindings' Standards docs, if listed, before writing code.
- Apply test-driven-development if available (see Inherited guidance) —
  don't assume a subtask can't be verified locally.
- After each subtask's verification passes, tick its checkbox in `plan.md`
  and update the Status header's phase line.
- Stage specific files only — never `git add .`.
- Commit as logical units complete.

## Phase 4 — QA loop

Dispatch a **fresh QA subagent** (not the one that planned) with:

- The diff: `git diff origin/<base>...HEAD` in the target repo.
- The acceptance criteria (spec.md if present, otherwise derived from the
  task).
- The bindings' Standards docs, if listed.
- Required output: a round section for `qa_report.md` — pass/fail per
  acceptance criterion, plus issues as `file:line — severity
(blocker/should-fix/nit) — issue — suggested fix`.

Append each round to `.acp/<task-id>/qa_report.md`. Fix blockers and
should-fixes in the main session, then re-dispatch a fresh reviewer.

**Cap: 3 rounds.** If issues remain after round 3:

- Attended: stop and surface them to the user rather than looping further.
- Unattended: leave the branch and findings in place and move on to the
  next task — never keep looping past the cap.

A clean round (no blockers, criteria all pass) exits the loop.

## Phase 5 — Ship

1. Execute the bindings' Ship policy (PR, push-only, or direct-merge, per
   `.claude/ac-bindings.md`) — commit/push/PR as the policy describes.
2. Check whatever gates the bindings or project require (CI, review) before
   treating the ship as clean — don't infer from "it pushed" alone.
3. The bindings' Done-transition (e.g. closing an issue, a tracker
   transition) is **attended-only** — never perform it unattended, even if
   every other gate is clean. In attended mode, make the actual transition
   call, don't just report "clean".

## Status header format

Top of `plan.md` (or standalone `status.md` for simple tasks):

```markdown
## Status

- Task: TASK-ID
- Complexity: medium — single repo but new endpoint + model change
- Branch: <branch-name> (repo: <repo-name>)
- Phase: implementation (subtask 2/5)
- Updated: 2026-08-09
```

Update `Phase:` and `Updated:` at every phase transition and subtask tick.

## Resume protocol

On `/ac <task>` with an existing `.acp/<task-id>/`:

1. Read the Status header.
2. Verify reality matches: the branch exists, and
   `git diff origin/<base>...HEAD` is consistent with the ticked subtasks.
3. If consistent, continue from the recorded phase.
4. If not (branch gone, diff doesn't match, tracker status changed), report
   the mismatch to the user and ask how to proceed — never guess.

## Operating modes

- **Attended (default).** Ask at gates: ambiguity, plan approval, posting
  externally, and ship. This is the mode for any interactive session,
  including bridge sessions, unless stated otherwise.
- **Unattended.** Only when the invoking prompt explicitly says so (e.g. a
  ralph loop prompt). Four hard rules apply:
  1. Ambiguous task → skip it and report why; never guess at intent.
  2. QA cap (3 rounds) reached → leave the branch and findings in place and
     move on to the next task; don't keep looping past the cap.
  3. Terminus is the bindings' Ship policy — stop there, don't invent
     further steps.
  4. The bindings' Done-transition is **never** performed unattended,
     regardless of how clean the result looks.

## Inherited guidance

These rules are lifted from the superpowers workflow skills and apply
whether or not superpowers is loaded in the session:

- **Plan quality bar** (writing-plans). Every subtask needs exact file
  paths, the key code or content inline where it's non-obvious, and
  explicit interface notes between subtasks that depend on each other.
  Reject a plan at review if any subtask says "TBD", "add appropriate error
  handling", or "similar to subtask N" — vague enough to hide the real work,
  re-dispatch the Plan subagent instead.
- **Verification before completion** (verification-before-completion). A
  subtask is only ticked, and a QA round only passes, after actually running
  the verification command and reading its output — a claim without shown
  output doesn't count, in either phase.
- **Clarification loop** (brainstorming). In attended mode, a complex task
  with genuine ambiguity may run a one-question-at-a-time clarification
  loop with the user before writing spec.md. Unattended mode never does
  this — see Operating modes, rule 1.
- **Apply if available**: test-driven-development and
  systematic-debugging. If those skills are present in the session, use
  them during Phase 3 implementation and debugging; if not, proceed with
  the guidance above on its own.

## Relationship to superpowers

This pipeline overlaps superpowers' workflow skills by design: the mini-spec
phase covers what brainstorming covers, and `plan.md` covers what
writing-plans covers. To avoid running both ceremonies in one session, this
skill declares the equivalence explicitly — an `/ac` run's task/ticket plus
mini-spec **satisfies** the brainstorming requirement, and its `plan.md`
**satisfies** writing-plans. In a session with superpowers loaded, follow
the ac pipeline as the single workflow rather than layering the superpowers
ceremonies on top of it.

## Common mistakes

| Problem                                          | Fix                                                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Branching without fetching                       | Always `git fetch origin` and branch from `origin/<base>` per the bindings                            |
| `git add .`                                      | Stage specific files only                                                                             |
| Skipping the plan review                         | Reject vague subtasks before implementing, not after                                                  |
| QA reviewer sees only the code, not the criteria | Always pass acceptance criteria + standards docs to the QA subagent                                   |
| Ship gate skipped                                | Check the bindings' required gates before calling the ship clean, don't infer from build status alone |
| Giving time estimates                            | Never — scope in files/repos, not hours                                                               |
| Guessing at ambiguity unattended                 | Skip and report instead — see Operating modes                                                         |
| Performing the Done-transition unattended        | Never — it's attended-only, always                                                                    |
| Missing `.claude/ac-bindings.md`                 | Stop and tell the user to run /installAC, or write it by hand                                         |

<!-- ac-pipeline-version: 1 -->
