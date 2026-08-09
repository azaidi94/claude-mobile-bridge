# /installAC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendored generic AC pipeline skill templates + a `/installAC <path>` bot command that installs them into any git repo with a generated bindings file.

**Architecture:** Pure-markdown templates under `templates/ac-pipeline/`; pure-logic installer module (`src/installac/install.ts`, unit-tested); thin grammY command handler + `acinstall:` callback branches for the 4-question setup flow.

**Tech Stack:** Bun + TypeScript (grammY bot), bun test, markdown skill files.

**Spec:** `docs/superpowers/specs/2026-08-09-installac-design.md`

## Global Constraints

- Template source material: generalize from `~/Projects/Cursor/kx2/kx_repo/.claude/skills/{jira-ac-pipeline,kx-pr-review,kx-investigate,kx-ideate}/SKILL.md` and their commands — same structure, all Kinetix/Jira specifics replaced by bindings references.
- Artifacts dir in installed projects: `.acp/` (never `.jiraAC/`).
- Every template file ends with `<!-- ac-pipeline-version: 1 -->`.
- Skill frontmatter `name:` must equal its directory name; descriptions start "Use when".
- No time estimates, no credentials, anywhere in templates.
- Unattended hard rules (verbatim in ac-pipeline SKILL.md): ambiguous → skip and report; QA cap → leave branch + findings, move on; terminus = ship policy; done-transition is never performed unattended.
- Installer writes only inside the target repo; commits with message `Install AC pipeline skills (ac-pipeline v1) via /installAC`.
- Repo conventions: prettier + tsc + full bun test suite run on commit (husky); keep all green.

---

### Task 1: ac-pipeline skill template

**Files:**

- Create: `templates/ac-pipeline/skills/ac-pipeline/SKILL.md`
- Create: `templates/ac-pipeline/commands/ac.md`

**Interfaces:**

- Produces: the phase structure, `.acp/<task-id>/` artifact conventions, Status-header format, and Operating-modes section that Tasks 2–3 reference.

- [ ] **Step 1: Write SKILL.md** — port `jira-ac-pipeline/SKILL.md` section-for-section with these transformations:
  - Phase 0 Intake: replace Jira lifecycle with "read `.claude/ac-bindings.md`; stop with 'run /installAC' if missing. Intake the task per the bindings' Tracker (jira MCP tools / `gh issue view` / described goal). Branch: `git fetch origin` then branch from `origin/<base>` per bindings."
  - Task id: ticket key when a tracker exists, else a kebab slug of the goal. Artifacts: `.acp/<task-id>/`.
  - Complexity rubric, mini-spec, planning, implementation, QA loop, Status header, resume protocol: keep structure; replace `standards-*.md` references with "the bindings' Standards docs, if listed"; replace kx-raise-pr/Sonar/DevVerified in Phase 5 with "execute the bindings' Ship policy; the Done-transition is attended-only".
  - Add **Operating modes** section: attended default (ask at gates); unattended only when the invoking prompt says so, with the four hard rules from Global Constraints.
  - Add **Inherited guidance**: plan quality bar (exact file paths, key code inline where non-obvious, interface notes between subtasks; reject "TBD"/"add appropriate error handling"/"similar to subtask N" at plan review); verification-before-completion (tick/pass only after running the verification and reading output); attended+complex may run a one-question-at-a-time clarification loop before spec.md; reference test-driven-development and systematic-debugging as "apply if available".
  - Add **Relationship to superpowers** paragraph: an /ac run's ticket+mini-spec satisfies the brainstorming requirement; plan.md satisfies writing-plans — one workflow, not two.
- [ ] **Step 2: Write `commands/ac.md`** — thin (≤ 30 lines): `Task: $ARGUMENTS` (ticket key or described goal); missing → ask; existing `.acp/<task-id>/` → offer resume; else run ac-pipeline phases in order; attended judgment note.
- [ ] **Step 3: Verify** — `head -3` shows `name: ac-pipeline`; `grep -c 'ac-bindings' SKILL.md` ≥ 4; `grep -ci 'jira\|kinetix\|bitbucket' SKILL.md` — jira appears only inside the tracker-options context, kinetix/bitbucket zero; version stamp present in both files.
- [ ] **Step 4: Commit** — `git add templates/ && git commit -m "templates: ac-pipeline skill + /ac command"`

---

### Task 2: ac-review, ac-investigate, ac-ideate templates

**Files:**

- Create: `templates/ac-pipeline/skills/ac-review/SKILL.md`, `.../ac-investigate/SKILL.md`, `.../ac-ideate/SKILL.md`
- Create: `templates/ac-pipeline/commands/ac-review.md`, `ac-investigate.md`, `ac-ideate.md`

**Interfaces:**

- Consumes: `.acp/` conventions + bindings fields from Task 1.
- Produces: complete skills/ + commands/ tree that Task 4's copy routine ships.

- [ ] **Step 1: ac-review** — from `kx-pr-review/SKILL.md`: fetch/present/post structure kept; platform mechanics become "per the bindings' Ship policy platform (GitHub: `gh pr view/diff`, `gh pr review --comment`; other platforms: whatever the project's existing skills/docs provide — if none, present findings in-session only)". Severity taxonomy (blocker/should-fix/nit), dedupe-against-existing-comments, and the never-post-without-approval hard rule kept verbatim.
- [ ] **Step 2: ac-investigate** — from `kx-investigate/SKILL.md`: keep read→trace→report→offer structure and confidence tags; tracker calls via bindings (jira MCP / `gh issue`); report path `.acp/investigations/<task-id>.md`; cross-repo search tools replaced by "the project's search tooling; plain grep otherwise".
- [ ] **Step 3: ac-ideate** — from `kx-ideate/SKILL.md`: three parallel lenses kept with the same lens focus lists; area resolution via "ask the user or the project's own docs" (no repo inventory assumption); report `.acp/ideation/<area>-<date>.md`; file tickets per bindings tracker, only explicit picks.
- [ ] **Step 4: Verify** — frontmatter names match dirs (loop check as in kx); zero `kinetix|bitbucket|code.kinetixtt` matches; commands each ≤ 30 lines; version stamps everywhere.
- [ ] **Step 5: Commit** — `"templates: ac-review, ac-investigate, ac-ideate"`

---

### Task 3: bindings + ralph prompt templates

**Files:**

- Create: `templates/ac-pipeline/bindings.template.md`
- Create: `templates/ac-pipeline/ralph-prompt.template.md`

**Interfaces:**

- Produces: `{{TRACKER}}`, `{{BASE_BRANCH}}`, `{{SHIP_POLICY}}`, `{{DONE_TRANSITION}}` placeholders that Task 4's `generateBindings()` substitutes.

- [ ] **Step 1: bindings.template.md** — exactly the spec's Layer-2 block, with the four `{{...}}` placeholders and a generated-by header comment carrying the version stamp.
- [ ] **Step 2: ralph-prompt.template.md** — each iteration: (1) intake next open task per `{{TRACKER}}` (jira: `jira_search` assigned+open; github: `gh issue list --assignee @me --state open --limit 1`; none: next unchecked entry in `plans/tasks.md`); none found → signal complete; (2) run the **ac-pipeline** skill in **unattended** mode on it; (3) on finish or skip, echo a one-line result and write `$RALPH_SIGNAL`. Include the skip-and-report + no-done-transition reminders inline.
- [ ] **Step 3: Verify** — `grep -o '{{[A-Z_]*}}' bindings.template.md | sort -u` yields exactly the four placeholders; ralph template mentions `$RALPH_SIGNAL` and "unattended".
- [ ] **Step 4: Commit** — `"templates: bindings + unattended ralph prompt"`

---

### Task 4: installer logic module (pure, unit-testable)

**Files:**

- Create: `src/installac/install.ts`
- Test: `src/__tests__/installac.test.ts` (Task 5)

**Interfaces:**

- Produces (consumed by Task 6's handler):

```ts
export type AcAnswers = {
  tracker: "jira" | "github" | "none";
  baseBranch: string; // e.g. "main"
  shipPolicy: "pr" | "push-only" | "direct-merge";
  installRalphPrompt: boolean;
};
export const TEMPLATE_VERSION: number; // parsed from templates at import
export function templatesRoot(): string; // <repo>/templates/ac-pipeline, resolved relative to import.meta.dir like ralph's vendored-script pattern
export function installedVersion(repo: string): number | null; // reads stamp from <repo>/.claude/skills/ac-pipeline/SKILL.md; null if absent
export function copyTemplates(repo: string): void; // skills/* + commands/* -> <repo>/.claude/ (overwrite)
export function ensureGitignore(repo: string): boolean; // appends ".acp/" once; returns whether it changed
export function generateBindings(answers: AcAnswers): string; // template + substitutions (done-transition: jira→"tracker transition (attended only)", github→"close issue (attended only)", none→"none")
export function writeBindings(repo: string, answers: AcAnswers): void; // never overwrites an existing ac-bindings.md — throws AcBindingsExists
export function writeRalphPrompt(repo: string): void; // -> <repo>/plans/prompt_tasks.md (mkdir -p; overwrite ok, it's vendored)
```

- [ ] **Step 1: Write failing tests first** (see Task 5 list — author the test file now with `describe.todo` removed for the cases covering copy, idempotent gitignore, bindings substitution, version read, bindings-exists throw). Run: `bun test src/__tests__/installac.test.ts` → FAIL (module missing).
- [ ] **Step 2: Implement `install.ts`** per the interface above. Use `node:fs` sync APIs (matches repo style in ralph store) and tmp-safe pure functions (all paths passed in).
- [ ] **Step 3:** `bun test src/__tests__/installac.test.ts` → PASS.
- [ ] **Step 4: Commit** — `"installac: installer logic + tests"`

---

### Task 5: installer tests (authored in Task 4 Step 1)

**Files:**

- Test: `src/__tests__/installac.test.ts`

Cases (each against a `mkdtempSync` scratch git repo):

- [ ] `copyTemplates` creates all 4 skills + 4 commands in `.claude/`.
- [ ] `ensureGitignore` appends `.acp/` once; second call returns false and leaves file unchanged.
- [ ] `generateBindings({tracker:"jira",baseBranch:"develop",shipPolicy:"pr",installRalphPrompt:true})` contains `Tracker**: jira`, `origin/develop`, no remaining `{{`.
- [ ] `installedVersion` is null pre-install, `TEMPLATE_VERSION` post-copy.
- [ ] `writeBindings` twice → second throws `AcBindingsExists`.

(Verified as part of Task 4's TDD cycle — this task is the checklist, not a second implementation.)

---

### Task 6: /installAC command handler + callbacks + registration

**Files:**

- Create: `src/handlers/commands/installac.ts`
- Modify: `src/handlers/commands/index.ts` (export `handleInstallAc`)
- Modify: `src/index.ts` (command registry list: `{ command: "installac", description: "Install AC pipeline skills into a repo" }` + route)
- Modify: `src/handlers/callback.ts` (branch on `callbackData.startsWith("acinstall:")`)

**Interfaces:**

- Consumes: Task 4's module; ralph's path helpers (`expandHome`, `getWorkingDir` from `../../settings`, `tryRealpathSync`), `busReply`, `isAuthorized`, grammY `InlineKeyboard`.

- [ ] **Step 1: Path + preflight** — parse `/installac <path>`; resolve exactly like `handleRalph` (`resolve(getWorkingDir(), expandHome(path))` + realpath); require existing dir + `git rev-parse --git-dir` success; report resolved path back.
- [ ] **Step 2: Q&A state machine** — module-level `Map<chatKey, {repo, step, answers}>`; on start, post Q1 with `InlineKeyboard` buttons `acinstall:tracker:jira|github|none`; callback handler advances: Q2 base branch (`acinstall:base:main|develop|master`), Q3 ship (`acinstall:ship:pr|push-only|direct-merge`), Q4 ralph prompt (`acinstall:ralph:yes|no`). Each callback edits the message to show the running answers (pattern: existing `ralph:`/settings callbacks).
- [ ] **Step 3: Finalize** — on Q4: `copyTemplates`, `ensureGitignore`, `writeBindings` (catch `AcBindingsExists` → upgrade path: skip bindings, note "bindings preserved"), optional `writeRalphPrompt`; `git add .claude plans/prompt_tasks.md .gitignore` (paths that exist) + commit with the constrained message; reply summary: version old→new (via `installedVersion` read before copy), files installed, next steps (`/new <repo>` then `/ac <task>`; `/ralph <repo>` if prompt installed).
- [ ] **Step 4: Verify** — `bunx tsc --noEmit` clean; `bun test` green; grep confirms command registered in `src/index.ts`.
- [ ] **Step 5: Commit** — `"installac: /installAC command, setup flow, registration"`

---

### Task 7: docs + manual end-to-end

**Files:**

- Modify: `README.md` (command table row + docs link)
- Create: `docs/installac.md` (usage, upgrade behavior, bindings reference, ralph integration)

- [ ] **Step 1:** Write `docs/installac.md` (mirror `docs/ralph-loops.md` tone: commands table, customization, safety rules) and add the README row.
- [ ] **Step 2: Manual E2E** — `mkdir scratch && git init`: run `/installAC scratch` from Telegram, answer none/main/pr/no; confirm files + commit in scratch repo; open a session there and run `/ac add a hello-world script` attended; then re-run `/installAC scratch` and confirm "bindings preserved" upgrade path.
- [ ] **Step 3: Commit** — `"docs: /installAC"`
