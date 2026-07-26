# Goal → tasks → ralph (GitHub-free planning front-end) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `/ralph` run without GitHub by draining a local `plans/tasks.md`, and add a `plan-tasks` skill that decomposes a freeform goal into a well-shaped, reviewable `tasks.md`.

**Architecture:** Three decoupled pieces. (1) A pure TypeScript queue module (`src/ralph/tasks-queue.ts`) + thin CLI (`src/ralph/tasks-queue-cli.ts`) that parse/advance a markdown checklist. (2) A GitHub-free loop script (`scripts/ralph/afk_tasks_md.sh`) set via `RALPH_SCRIPT` that reuses the vendored loop's watchdog/signal/`script` machinery but swaps the `gh` queue for `tasks.md` draining via the CLI, emitting the exact stdout markers the bot's `RalphLogParser` keys on. (3) A single-file skill (`.claude/skills/plan-tasks.md`) that writes the draft `tasks.md`. A new vendored prompt (`scripts/ralph/prompt_tasks_md.md`) drives each cold iteration.

**Tech Stack:** TypeScript + Bun (`bun test`), Bash. Spec: `docs/superpowers/specs/2026-07-21-goal-to-tasks-ralph-design.md`.

## Global Constraints

- **No GitHub in this path.** The loop script must not call `gh`. Queue comes from `plans/tasks.md` only.
- **Reuse the existing loop contract verbatim.** Keep the `tmpfile`/`signalfile`/background-watchdog/`script -q "$tmpfile" claude … "$CONTEXT"` machinery from `scripts/ralph/afk_tasks.sh` unchanged, so the bot's watchdog, `verbose`, and `/ralph stop` tree-kill keep working.
- **Marker strings are a hard contract.** The outer script MUST echo these literal, column-0 strings (parsed by `src/ralph/events.ts`): `=== Iteration N/M ===`, `All issues resolved after N iterations.`, `Waiting for other agents to complete blocking tasks...`, `Reached max iterations (N)`, `Timeout after Ns …`. Do not reword them even though they say "issues".
- **Direct-merge only; warn on `-pr`.** `-pr` needs `gh`; the script prints a warning and proceeds in direct mode. `-l <label>` is accepted and ignored.
- **Inner session never edits `tasks.md`.** The outer script owns checkbox state (flip `[ ]`→`[x]` on `DONE`).
- **Commit style:** no "Generated with Claude Code" footer, no `Co-Authored-By` trailer.
- **Signal contract:** inner session writes a status word to `$RALPH_SIGNAL` (`DONE` / `COMPLETE` / `WAITING`); it never runs `kill`.

---

### Task 1: `tasks-queue` pure module

**Files:**

- Create: `src/ralph/tasks-queue.ts`
- Test: `src/__tests__/tasks-queue.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `interface TaskItem { id: number; title: string; done: boolean; dependsOn: number[]; block: string }`
  - `function parseTasks(md: string): TaskItem[]`
  - `function nextEligible(items: TaskItem[]): TaskItem | null`
  - `type QueueStatus = "ready" | "complete" | "waiting"`
  - `function queueStatus(items: TaskItem[]): QueueStatus`
  - `function markDone(md: string, id: number): string`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/tasks-queue.test.ts
import { describe, it, expect } from "bun:test";
import {
  parseTasks,
  nextEligible,
  queueStatus,
  markDone,
} from "../ralph/tasks-queue";

const SAMPLE = `# Plan: demo

## [ ] 1. First thing
**Acceptance:** it works.
**Depends on:** none
**Context:** src/a.ts

## [ ] 2. Second thing
**Acceptance:** also works.
**Depends on:** 1
**Context:** src/b.ts
`;

describe("tasks-queue: parseTasks", () => {
  it("parses id, title, done, dependsOn, and block", () => {
    const items = parseTasks(SAMPLE);
    expect(items.map((i) => i.id)).toEqual([1, 2]);
    expect(items[0]!.title).toBe("First thing");
    expect(items[0]!.done).toBe(false);
    expect(items[0]!.dependsOn).toEqual([]);
    expect(items[1]!.dependsOn).toEqual([1]);
    expect(items[0]!.block).toContain("**Acceptance:** it works.");
    expect(items[0]!.block).not.toContain("Second thing");
  });

  it("reads a checked item as done", () => {
    const items = parseTasks(SAMPLE.replace("## [ ] 1.", "## [x] 1."));
    expect(items[0]!.done).toBe(true);
  });
});

describe("tasks-queue: nextEligible", () => {
  it("returns the lowest undone item whose deps are all done", () => {
    const items = parseTasks(SAMPLE);
    expect(nextEligible(items)!.id).toBe(1); // 2 is blocked by 1
  });

  it("advances once the blocker is done", () => {
    const items = parseTasks(SAMPLE.replace("## [ ] 1.", "## [x] 1."));
    expect(nextEligible(items)!.id).toBe(2);
  });

  it("returns null when all items are done", () => {
    const md = SAMPLE.replace("## [ ] 1.", "## [x] 1.").replace(
      "## [ ] 2.",
      "## [x] 2.",
    );
    expect(nextEligible(parseTasks(md))).toBeNull();
  });
});

describe("tasks-queue: queueStatus", () => {
  it("is ready when an eligible item exists", () => {
    expect(queueStatus(parseTasks(SAMPLE))).toBe("ready");
  });

  it("is complete when everything is done", () => {
    const md = SAMPLE.replace("## [ ] 1.", "## [x] 1.").replace(
      "## [ ] 2.",
      "## [x] 2.",
    );
    expect(queueStatus(parseTasks(md))).toBe("complete");
  });

  it("is waiting when undone items remain but none are eligible", () => {
    // Item 2 depends on missing id 9 → never satisfiable; item 1 removed.
    const blocked = `# Plan: x

## [ ] 2. Blocked
**Depends on:** 9
`;
    expect(queueStatus(parseTasks(blocked))).toBe("waiting");
  });
});

describe("tasks-queue: markDone", () => {
  it("flips only the targeted item's checkbox", () => {
    const out = markDone(SAMPLE, 1);
    expect(out).toContain("## [x] 1. First thing");
    expect(out).toContain("## [ ] 2. Second thing");
  });

  it("is idempotent on an already-done item", () => {
    const once = markDone(SAMPLE, 1);
    expect(markDone(once, 1)).toBe(once);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/tasks-queue.test.ts`
Expected: FAIL — `Cannot find module "../ralph/tasks-queue"`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ralph/tasks-queue.ts
/**
 * Pure parser/advancer for a ralph `plans/tasks.md` checklist. No IO.
 * Items are markdown headers `## [ ] N. Title` / `## [x] N. Title`; an item's
 * block runs from its header up to the next `## ` header (or EOF).
 */

export interface TaskItem {
  id: number;
  title: string;
  done: boolean;
  dependsOn: number[];
  block: string;
}

export type QueueStatus = "ready" | "complete" | "waiting";

const HEADER_RE = /^## \[( |x)\] (\d+)\. (.*)$/;

/** Parse the full tasks.md into ordered items (by appearance). */
export function parseTasks(md: string): TaskItem[] {
  const lines = md.split("\n");
  const items: TaskItem[] = [];
  let current: { header: RegExpMatchArray; body: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const [, mark, idStr, title] = current.header;
    const block = [current.header.input, ...current.body].join("\n").trim();
    const depLine = current.body.find((l) => /^\*\*Depends on:\*\*/.test(l));
    const dependsOn =
      depLine && !/none/i.test(depLine)
        ? (depLine.match(/\d+/g) ?? []).map(Number)
        : [];
    items.push({
      id: Number(idStr),
      title: title!.trim(),
      done: mark === "x",
      dependsOn,
      block,
    });
    current = null;
  };

  for (const line of lines) {
    const m = line.match(HEADER_RE);
    if (m) {
      flush();
      current = { header: m, body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return items;
}

/** Lowest-id undone item whose every dependency is a done item. */
export function nextEligible(items: TaskItem[]): TaskItem | null {
  const doneIds = new Set(items.filter((i) => i.done).map((i) => i.id));
  const pending = items.filter((i) => !i.done).sort((a, b) => a.id - b.id);
  for (const item of pending) {
    if (item.dependsOn.every((d) => doneIds.has(d))) return item;
  }
  return null;
}

export function queueStatus(items: TaskItem[]): QueueStatus {
  if (items.every((i) => i.done)) return "complete";
  return nextEligible(items) ? "ready" : "waiting";
}

/** Return md with item `id`'s checkbox flipped to `[x]` (idempotent). */
export function markDone(md: string, id: number): string {
  const re = new RegExp(`^(## )\\[ \\](\\s${id}\\. )`, "m");
  return md.replace(re, `$1[x]$2`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/tasks-queue.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/ralph/tasks-queue.ts src/__tests__/tasks-queue.test.ts
git commit -m "feat(ralph): pure tasks.md queue parser/advancer"
```

---

### Task 2: `tasks-queue` CLI

**Files:**

- Create: `src/ralph/tasks-queue-cli.ts`
- Test: `src/__tests__/tasks-queue-cli.test.ts`

**Interfaces:**

- Consumes: `parseTasks`, `nextEligible`, `queueStatus`, `markDone` from Task 1.
- Produces: `function runCli(argv: string[]): string` — `argv = ["next", file]` returns a JSON string (`{"status":"ready","id":N,"title":..,"block":..}` or `{"status":"complete"|"waiting"}`); `argv = ["done", file, id]` mutates the file in place and returns `""`. Also runnable as `bun src/ralph/tasks-queue-cli.ts <cmd> <file> [id]`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/tasks-queue-cli.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runCli } from "../ralph/tasks-queue-cli";

const SAMPLE = `# Plan: demo

## [ ] 1. First
**Depends on:** none

## [ ] 2. Second
**Depends on:** 1
`;

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tq-cli-"));
  file = join(dir, "tasks.md");
  writeFileSync(file, SAMPLE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("tasks-queue-cli: next", () => {
  it("returns the ready item with id and block", () => {
    const out = JSON.parse(runCli(["next", file]));
    expect(out.status).toBe("ready");
    expect(out.id).toBe(1);
    expect(out.block).toContain("## [ ] 1. First");
  });

  it("returns complete when the file is missing", () => {
    const out = JSON.parse(runCli(["next", join(dir, "nope.md")]));
    expect(out.status).toBe("complete");
  });
});

describe("tasks-queue-cli: done", () => {
  it("flips the item in the file on disk", () => {
    runCli(["done", file, "1"]);
    expect(readFileSync(file, "utf8")).toContain("## [x] 1. First");
    const out = JSON.parse(runCli(["next", file]));
    expect(out.id).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/tasks-queue-cli.test.ts`
Expected: FAIL — `Cannot find module "../ralph/tasks-queue-cli"`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ralph/tasks-queue-cli.ts
/**
 * Thin CLI wrapper over tasks-queue, invoked by scripts/ralph/afk_tasks_md.sh:
 *   bun src/ralph/tasks-queue-cli.ts next plans/tasks.md   → JSON status/item
 *   bun src/ralph/tasks-queue-cli.ts done plans/tasks.md 2 → flip item 2 to [x]
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { parseTasks, nextEligible, queueStatus, markDone } from "./tasks-queue";

export function runCli(argv: string[]): string {
  const [cmd, file, idArg] = argv;
  if (!cmd || !file) throw new Error("usage: <next|done> <file> [id]");

  if (cmd === "next") {
    if (!existsSync(file)) return JSON.stringify({ status: "complete" });
    const items = parseTasks(readFileSync(file, "utf8"));
    const status = queueStatus(items);
    if (status !== "ready") return JSON.stringify({ status });
    const item = nextEligible(items)!;
    return JSON.stringify({
      status: "ready",
      id: item.id,
      title: item.title,
      block: item.block,
    });
  }

  if (cmd === "done") {
    const id = Number(idArg);
    if (!Number.isInteger(id)) throw new Error(`bad id: ${idArg}`);
    writeFileSync(file, markDone(readFileSync(file, "utf8"), id));
    return "";
  }

  throw new Error(`unknown command: ${cmd}`);
}

if (import.meta.main) {
  const out = runCli(process.argv.slice(2));
  if (out) process.stdout.write(out + "\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/tasks-queue-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ralph/tasks-queue-cli.ts src/__tests__/tasks-queue-cli.test.ts
git commit -m "feat(ralph): tasks.md queue CLI (next/done)"
```

---

### Task 3: Vendored single-item prompt

**Files:**

- Create: `scripts/ralph/prompt_tasks_md.md`

**Interfaces:**

- Consumes: nothing at build time. At runtime the loop script appends `@scripts/ralph/prompt_tasks_md.md` to the item block + `BASE BRANCH: <name>` context.
- Produces: the prompt contract the inner cold session follows (do one item, merge to base, signal `DONE`, never edit `tasks.md`).

- [ ] **Step 1: Create the prompt file**

```markdown
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
```

- [ ] **Step 2: Verify it exists and reads correctly**

Run: `test -f scripts/ralph/prompt_tasks_md.md && head -1 scripts/ralph/prompt_tasks_md.md`
Expected: prints `<!-- scripts/ralph/prompt_tasks_md.md -->`.

- [ ] **Step 3: Commit**

```bash
git add scripts/ralph/prompt_tasks_md.md
git commit -m "feat(ralph): vendored single-item prompt for tasks.md loop"
```

---

### Task 4: GitHub-free loop script + integration test

**Files:**

- Create: `scripts/ralph/afk_tasks_md.sh`
- Test: `src/__tests__/afk-tasks-md.test.ts`
- Reference (do not modify): `scripts/ralph/afk_tasks.sh` (machinery to mirror), `scripts/ralph-runner.sh:12` (how `RALPH_SCRIPT` is invoked).

**Interfaces:**

- Consumes: `bun <mb-root>/src/ralph/tasks-queue-cli.ts` (Task 2), `scripts/ralph/prompt_tasks_md.md` (Task 3).
- Produces: an executable `RALPH_SCRIPT` that takes `[-pr] [-l <label>] <iterations>` (same argv as `afk_tasks.sh`), drains `plans/tasks.md`, and emits the contract marker strings.

- [ ] **Step 1: Write the failing integration test**

```typescript
// src/__tests__/afk-tasks-md.test.ts
import { describe, it, expect } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  chmodSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execFileSync } from "child_process";

const SCRIPT = resolve(import.meta.dir, "../../scripts/ralph/afk_tasks_md.sh");

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("afk_tasks_md.sh", () => {
  it("drains a 2-item tasks.md and reports completion", () => {
    const repo = mkdtempSync(join(tmpdir(), "ralph-md-"));
    try {
      // A throwaway git repo with a plans/tasks.md queue.
      git(repo, ["init", "-b", "main"]);
      git(repo, ["config", "user.email", "t@t"]);
      git(repo, ["config", "user.name", "t"]);
      mkdirSync(join(repo, "plans"));
      writeFileSync(
        join(repo, "plans/tasks.md"),
        `# Plan: demo\n\n## [ ] 1. One\n**Depends on:** none\n\n## [ ] 2. Two\n**Depends on:** 1\n`,
      );
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-m", "init"]);

      // Stub `claude`: just signal DONE (the loop machinery owns the rest).
      const bin = join(repo, ".bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "claude"),
        `#!/bin/bash\necho DONE > "$RALPH_SIGNAL"\n`,
      );
      chmodSync(join(bin, "claude"), 0o755);

      const out = execFileSync("bash", [SCRIPT, "5"], {
        cwd: repo,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: "utf8",
      });

      const md = readFileSync(join(repo, "plans/tasks.md"), "utf8");
      expect(md).toContain("## [x] 1. One");
      expect(md).toContain("## [x] 2. Two");
      expect(out).toContain("All issues resolved after");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/afk-tasks-md.test.ts`
Expected: FAIL — bash cannot execute a non-existent `afk_tasks_md.sh`.

- [ ] **Step 3: Write the loop script**

```bash
#!/bin/bash
# GitHub-free ralph loop: drains plans/tasks.md instead of `gh issue list`.
# Set RALPH_SCRIPT=/abs/scripts/ralph/afk_tasks_md.sh to use it. Reuses the
# vendored loop's tmpfile/signal/watchdog/`script` machinery verbatim so the
# bot's watchdog, verbose streaming, and `/ralph stop` keep working.

PR_MODE=false
ITERATIONS=""
# LABEL parsed and ignored (GitHub-issue concept; no gh here).
while [[ $# -gt 0 ]]; do
  case "$1" in
    -pr|--pr) PR_MODE=true; shift ;;
    -l|--label) shift 2 ;;
    *) ITERATIONS="$1"; shift ;;
  esac
done

if [ -z "$ITERATIONS" ]; then
  echo "Usage: $0 [-pr] [-l <label>] <iterations>"
  exit 1
fi
if [ "$PR_MODE" = true ]; then
  echo "note: -pr needs gh and is ignored here — direct-merge only."
fi

TASKS_FILE="plans/tasks.md"
if [ ! -f "$TASKS_FILE" ]; then
  echo "No $TASKS_FILE in $(pwd) — nothing to do."
  exit 1
fi

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
MB_ROOT="$(cd "$SELF_DIR/../.." && pwd)"
CLI="$MB_ROOT/src/ralph/tasks-queue-cli.ts"

PROMPT_FILE="${RALPH_PROMPT:-$SELF_DIR/prompt_tasks_md.md}"
if [ -f "plans/prompt_tasks.md" ]; then
  PROMPT_FILE="plans/prompt_tasks.md"
fi

BASE_BRANCH="$(git branch --show-current)"

# --- session-control helpers (parent owns termination) — mirror afk_tasks.sh ---
pids_of_tree() { local p=$1 c; [ -z "$p" ] && return; echo "$p"; for c in $(pgrep -P "$p" 2>/dev/null); do pids_of_tree "$c"; done; }
kill_session() { local tree; tree=$(pids_of_tree "$(pgrep -f "$1" 2>/dev/null | head -1)"); [ -n "$tree" ] && { kill -TERM $tree 2>/dev/null; sleep 2; kill -KILL $tree 2>/dev/null; }; }
cleanup() { [ -n "$watchdog" ] && kill "$watchdog" 2>/dev/null; [ -n "$tmpfile" ] && kill_session "$tmpfile"; rm -f "$tmpfile" "$signalfile" 2>/dev/null; }
trap cleanup EXIT INT TERM

for ((i=1; i<=$ITERATIONS; i++)); do
  echo "=== Iteration $i/$ITERATIONS ==="

  q=$(bun "$CLI" next "$TASKS_FILE")
  status=$(echo "$q" | jq -r .status)

  if [ "$status" = "complete" ]; then
    echo "All issues resolved after $i iterations."
    exit 0
  fi
  if [ "$status" = "waiting" ]; then
    echo "Waiting for other agents to complete blocking tasks..."
    sleep 5
    continue
  fi

  id=$(echo "$q" | jq -r .id)
  block=$(echo "$q" | jq -r .block)

  CONTEXT="$block

BASE BRANCH: $BASE_BRANCH

@$PROMPT_FILE"

  tmpfile=$(mktemp)
  signalfile=$(mktemp); rm -f "$signalfile"
  export RALPH_SIGNAL="$signalfile"
  TIMEOUT=${RALPH_TIMEOUT:-1800}

  # Background watchdog: the PARENT owns termination (identical to afk_tasks.sh).
  (
    for n in $(seq 1 100); do pgrep -f "$tmpfile" >/dev/null 2>&1 && break; sleep 0.1; done
    waited=0
    while [ ! -f "$signalfile" ] && [ "$waited" -lt "$TIMEOUT" ]; do
      pgrep -f "$tmpfile" >/dev/null 2>&1 || exit 0
      sleep 1; waited=$((waited+1))
    done
    [ "$waited" -ge "$TIMEOUT" ] && echo "Timeout after ${TIMEOUT}s — killing session"
    sleep 1
    kill_session "$tmpfile"
  ) &
  watchdog=$!

  script -q "$tmpfile" claude --dangerously-skip-permissions "$CONTEXT" || true

  kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null

  signal=$(cat "$signalfile" 2>/dev/null)
  rm -f "$tmpfile" "$signalfile"

  if [ "$signal" = "COMPLETE" ]; then
    echo "All issues resolved after $i iterations."
    exit 0
  fi
  if [ "$signal" = "WAITING" ]; then
    echo "Waiting for other agents to complete blocking tasks..."
    sleep 5
    continue
  fi
  if [ "$signal" = "DONE" ]; then
    bun "$CLI" done "$TASKS_FILE" "$id"
    git add "$TASKS_FILE" 2>/dev/null
    git commit -m "chore(ralph): mark task $id done" 2>/dev/null || true
  fi
  # Empty/other signal (timeout, crash): don't mark done — retry next iteration.
done

echo "Reached max iterations ($ITERATIONS)"
```

- [ ] **Step 4: Make it executable, run the test to verify it passes**

Run: `chmod +x scripts/ralph/afk_tasks_md.sh && bun test src/__tests__/afk-tasks-md.test.ts`
Expected: PASS — both items become `[x]` and output contains `All issues resolved after`.

- [ ] **Step 5: Commit**

```bash
git add scripts/ralph/afk_tasks_md.sh src/__tests__/afk-tasks-md.test.ts
git commit -m "feat(ralph): GitHub-free loop script draining plans/tasks.md"
```

---

### Task 5: `plan-tasks` skill

**Files:**

- Create: `.claude/skills/plan-tasks.md`
- Reference: `.claude/skills/explore-codebase.md` (single-file skill frontmatter format).

**Interfaces:**

- Consumes: the `tasks.md` format contract (Task 1's parser expects `## [ ] N. Title` headers with `**Depends on:**` lines).
- Produces: a skill that writes a draft `plans/tasks.md` into the target repo and stops.

- [ ] **Step 1: Create the skill file**

````markdown
---
name: Plan Tasks
description: Decompose a freeform goal into a well-shaped plans/tasks.md queue for a ralph loop (GitHub-free). Invoke as /plan-tasks [<repo-path>] <goal>.
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
````

Number items from 1, sequentially. `Depends on:` is `none` or a comma-list of
earlier item numbers. 6. **Self-check the draft** before finishing: no dependency cycles, no vague
acceptance criteria, no oversized items, no duplicates. Fix inline. 7. **Hand off.** Tell the user the draft is written for review and that they can
edit it, then run `/ralph <repo>` (with the tasks.md `RALPH_SCRIPT`
configured). Do not run anything yourself.

````

- [ ] **Step 2: Verify the skill frontmatter parses**

Run: `head -4 .claude/skills/plan-tasks.md`
Expected: shows the `---` frontmatter with `name: Plan Tasks` and a `description:` line.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/plan-tasks.md
git commit -m "feat(skills): plan-tasks — goal to plans/tasks.md decomposer"
````

---

### Task 6: Documentation

**Files:**

- Modify: `docs/ralph-loops.md` (the "Customizing the loop" section)
- Modify: `.env.example:98` (near the existing `RALPH_SCRIPT` note)

**Interfaces:**

- Consumes: the artifacts from Tasks 3–5 (script path, skill, prompt).
- Produces: user-facing instructions for the GitHub-free flow.

- [ ] **Step 1: Add a GitHub-free section to `docs/ralph-loops.md`**

Insert after the "Customizing the loop" section:

````markdown
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

​```markdown

# Plan: <goal>

## [ ] 1. <title>

**Acceptance:** <done condition>
**Depends on:** none
**Context:** <pointers>
​```

The outer script owns the checkboxes (it flips `[ ]`→`[x]` when a session signals
`DONE`); you own the file between runs (reorder, edit acceptance, re-open a task
by flipping `[x]`→`[ ]`).

Limitations in this mode: `-pr` needs `gh`, so it's **direct-merge only** (the
script warns and proceeds); `-l <label>` is ignored.
````

- [ ] **Step 2: Update `.env.example`**

Change the `RALPH_SCRIPT` note near line 98 to mention the vendored GitHub-free option:

```bash
# Alternative /ralph loop script. Empty = vendored scripts/ralph/afk_tasks.sh (GitHub issues).
# For a GitHub-free loop driven by plans/tasks.md, point this at the vendored:
# RALPH_SCRIPT=/abs/path/to/scripts/ralph/afk_tasks_md.sh
```

- [ ] **Step 3: Verify docs render / links resolve**

Run: `grep -n "afk_tasks_md.sh" docs/ralph-loops.md .env.example`
Expected: matches in both files.

- [ ] **Step 4: Commit**

```bash
git add docs/ralph-loops.md .env.example
git commit -m "docs(ralph): document the GitHub-free plans/tasks.md loop"
```

---

## Notes for the implementer

- Run the **full** suite once at the end: `bun run typecheck && bun test`. The
  repo's pre-commit hook also runs prettier + typecheck + isolated tests, so
  commits will fail fast if something's off.
- Do **not** modify `scripts/ralph/afk_tasks.sh`, `src/ralph/events.ts`, or the
  bot-side monitor — the whole point is that the new script speaks their existing
  contract. If a marker beat doesn't fire, the bug is a mismatched echo string in
  `afk_tasks_md.sh`, not the parser.
- The integration test (Task 4) shells out to `bash`, `git`, `bun`, and `script`
  — it's macOS-oriented, matching ralph's platform constraint.
