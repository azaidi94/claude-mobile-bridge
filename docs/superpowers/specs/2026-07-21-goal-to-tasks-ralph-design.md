# Goal → tasks → ralph (GitHub-free planning front-end)

**Status:** design approved 2026-07-21
**Related:** [`docs/ralph-loops.md`](../../ralph-loops.md), the web tasks board (PR #63)

## Problem

`/ralph` is an issue-driven autonomous loop: each iteration is a fresh, cold
Claude session that picks the first open **GitHub issue**, does the work on a
branch, and either merges to base or opens a PR. Its output quality is bounded
by the quality of that queue — well-scoped, self-contained issues produce good
runs; vague ones produce vague commits.

Two gaps:

1. **GitHub dependency.** The vendored loop (`scripts/ralph/afk_tasks.sh`) builds
   its queue with `gh issue list`, so `/ralph` can't run on a repo without a
   GitHub remote, `gh` auth, and open issues.
2. **No goal→queue decomposition.** Turning a high-level goal into a well-shaped
   _set_ of iteration-sized work items is entirely manual today (hand-writing
   issues). This "shaping" is the highest-leverage quality lever and nothing
   automates it.

Note there are already **two** decomposition layers, and only one is missing.
Layer 2 (one item → subtasks) already exists: the vendored ralph prompt tells
each iteration to call `TaskList`/`TaskCreate` and break its single issue into
ordered subtasks. Layer 1 (a goal → the list of iteration-sized items) is the
gap this design fills.

## Goals

- Run `/ralph` with **no GitHub** — drive the loop from a local file.
- Turn a freeform **goal** into a well-shaped, reviewable task list aligned to
  how ralph consumes work (cold sessions, ordering, per-item finish condition).
- Keep a **human review gate** between decomposition and execution.
- Reuse the existing `/ralph` machinery (topic, beats, watchdog, `verbose`,
  `stop`) unchanged.

## Non-goals

- Replacing the GitHub loop — the default `afk_tasks.sh` stays as-is.
- Auto-running the loop straight from a goal (no review gate). Explicitly out.
- PR mode or issue-label scoping in the GitHub-free path (both are `gh`-specific;
  see Limitations).
- Visualizing the `tasks.md` queue on the web tasks board (the board reads
  `~/.claude/tasks`, not `tasks.md`). Possible later, out of scope here.

## Design overview

Three **decoupled** parts, each usable alone; they compose into one flow:

```
/plan-tasks <goal>  →  draft plans/tasks.md  →  [you edit]  →  /ralph <repo>  →  drains the list  →  done
     (skill)              (the queue)          (review gate)   (GitHub-free RALPH_SCRIPT)
```

1. **`plan-tasks` skill** — invoked in a live Claude session as
   `/plan-tasks <goal>` (works from Telegram by messaging the session). Explores
   the repo, decomposes the goal into iteration-sized items, writes a **draft**
   `plans/tasks.md`, and stops. Never runs anything.
2. **`plans/tasks.md`** — the human-readable, editable queue and the review gate.
3. **GitHub-free `RALPH_SCRIPT`** — drains `plans/tasks.md` one eligible item per
   iteration, marks items done, emits `COMPLETE` when the list is empty.

Decoupling matters: you can hand-write `tasks.md` and still use the script, or
use the skill to draft a list you paste elsewhere. Neither piece requires the
other.

## Component 1 — `plans/tasks.md` format

A markdown checklist; each item is a small detail block:

```markdown
# Plan: <goal restated>

## [ ] 1. <imperative title>

**Acceptance:** what "done" looks like — the cold session's finish test.
**Depends on:** none
**Context:** pointers (files, prior art) so the session needn't rediscover them.

## [ ] 2. <title>

**Acceptance:** ...
**Depends on:** 1
```

### Read/write contract (format and script stay in lockstep)

- **Pick:** the lowest-numbered `[ ]` item whose every `Depends on` item is `[x]`.
  Its block becomes the iteration's prompt context.
- **Advance:** the **outer script owns `tasks.md` state.** When the inner cold
  session signals `DONE` via `$RALPH_SIGNAL`, the script flips that item
  `[ ]`→`[x]`. The inner session never edits the queue — identical contract to
  today (inner does work + signals; outer manages loop state).
- **Finish:** no `[ ]` items left → emit `COMPLETE`. Items remain but all are
  dependency-blocked → `WAITING` (mirrors the GitHub loop's semantics).

The `[ ]`/`[x]` checkboxes double as an at-a-glance progress view and the edit
surface: between runs you can reorder, rewrite acceptance criteria, add/remove
items, or re-open a task by flipping `[x]`→`[ ]`.

## Component 2 — the `plan-tasks` skill

A skill (slash command) run inside any Claude session.

### Initiation / interface

`/plan-tasks [<repo-path>] <goal>` — the goal is a freeform sentence; the repo
path is **optional**:

- **No path** → plans the repo the current session is in (its working
  directory). The natural remote flow: message a session already bound to that
  repo's topic; the draft streams back into that topic.
- **With path** → plans the repo at `<repo-path>` (expanded/resolved like
  `/ralph` and `/new`), so you can kick off planning for another repo from any
  chat (e.g. General) without first opening a session there.

Either way the skill runs in a live Claude session (works from Telegram by
messaging the session, or from a desktop terminal). It writes the draft into the
**target repo's** `plans/tasks.md`.

### Decomposition rules

What makes it more than "ask Claude for a todo list":

- **Explore before decomposing.** Read repo structure, conventions, and how tests
  run, so items reference real files and commands.
- **Size each item to one cold session on one branch:** a single coherent change
  with a testable outcome. Split when an item spans unrelated areas or can't be
  verified in one pass; merge when a "task" is too trivial for its own iteration.
  This sizing is the skill's core value.
- **Sequence with dependencies, not prose.** Foundational work first;
  `investigate → implement → test` becomes explicit `Depends on:` links.
- **Enforce self-containment.** Each item's `Acceptance` + `Context` must let a
  session with zero memory of the plan finish it. If an item only makes sense
  "after task 2", make the dependency explicit or merge the items.
- **Stay bounded — no open-ended items.** Refuse "keep refactoring"-style tasks
  that never satisfy an acceptance test; the loop would never reach `COMPLETE`.
  Every item has a finish line.
- **Rich per item, scaled to complexity.** Rich (title + acceptance + context +
  deps) because cold sessions can't ask questions — but a trivial item gets one
  line of acceptance, a complex one gets several. Rich ≠ verbose.
- **Draft + self-check.** After drafting, pass over the output for dependency
  cycles, vague acceptance criteria, oversized items, duplicates; fix inline.
  Write the draft and stop — never start ralph.

Output: a draft `plans/tasks.md` in the target repo, then hand off to the user
for review.

## Component 3 — the GitHub-free `RALPH_SCRIPT`

A bash script set as `RALPH_SCRIPT` in `.env`, replacing `afk_tasks.sh`'s
`gh`-based queue with `tasks.md` draining, honoring the existing loop contract:

- Receives the repo path + args from `ralph-runner.sh`, same as today.
- Each iteration: pick the next eligible `[ ]` item, build the prompt from a
  **new vendored tasks.md prompt** (`scripts/ralph/prompt_tasks_md.md`) + the
  item's block, invoke `claude` with `$RALPH_SIGNAL` exported. The existing
  `prompt_tasks.md` is GitHub-issue-oriented (it reads issues JSON and calls
  `gh`), so it is _not_ reused here; the new prompt instructs the session to do
  the one supplied item, signal `DONE` to `$RALPH_SIGNAL`, and never edit
  `tasks.md`. `RALPH_PROMPT` / a repo's `plans/prompt_tasks.md` still override it,
  same as today.
- On `DONE` → flip the item to `[x]` and commit/merge to base; empty → `COMPLETE`;
  all-blocked → `WAITING`.
- Emits the **same echo markers** as the vendored script (`iter N/M`, next-item
  title, terminal beats) so topic beats stay rich. Watchdog, `verbose`, and
  `/ralph stop` tree-kill are relay/marker-driven and keep working unchanged.

### Limitations (baked in, surfaced to the user)

- **`-pr` mode needs `gh`** to open PRs → this script is **direct-merge only**;
  it warns if `-pr` is passed.
- **`-l <label>` is a GitHub-issue concept** → ignored here.

Everything else about `/ralph` is unchanged.

## Testing

- **Unit (bun):** queue logic lives in a TypeScript module
  `src/ralph/tasks-queue.ts` (parse, pick-next-eligible, dependency-blocking,
  mark-done, `COMPLETE`/`WAITING` detection), tested over fixtures — matching how
  the rest of `src/ralph/` is built. The bash script stays thin and calls it.
- **Integration:** run the script against a throwaway repo with a 2-item
  `tasks.md` and a stub `claude` that immediately signals `DONE`; assert both
  items flip to `[x]` and `COMPLETE` fires.
- **Skill:** prompt-based, validated by dogfooding — run `/plan-tasks` on a real
  goal and eyeball the draft.

## Open questions / future

- Optionally mirror `tasks.md` items into `~/.claude/tasks` so the web tasks
  board visualizes queue progress live. Out of scope now; the pipeline aligns
  with it if wanted later.
