# Decision doc: where the AC pipeline skills should live, and what to adopt vs replace

**Date:** 2026-08-09 · **Status:** For team discussion · **Context:** the `/installAC` feature (merged on `feat/new-spawn-tmux`) vendors generic "AC pipeline" skills inside this bot repo. The team has raised two questions: (1) is the bot the right home for these skills, and (2) do better alternatives exist — specifically [mattpocock/skills](https://github.com/mattpocock/skills) (e.g. the `wayfinder` skill) — for this and for superpowers.

## The three-layer picture

The tools under discussion do three different jobs. Most of the confusion dissolves once they're separated:

| Layer                      | Job                                                                                                                                                                                                                 | Who covers it today                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **1. Charting**            | Turn a large, foggy idea into scoped tickets. Multi-session, human-in-the-loop, decision-mapping on the tracker.                                                                                                    | Nobody in our stack. `wayfinder` does exactly this.                                                                      |
| **2. Delivery**            | Take one scoped ticket through plan → implement → QA loop → ship, with project bindings (tracker, base branch, ship policy, done-transition), adaptive depth, resumable state — attended **or unattended** (ralph). | Our AC skills. Nothing in wayfinder, mattpocock, or superpowers does this.                                               |
| **3. Process disciplines** | TDD, debugging, code review, requirement grilling — stateless engineering habits.                                                                                                                                   | Superpowers and mattpocock both; our AC skills inherit the key rules as plain text, so they work with either or neither. |

**Answer to "adopt wayfinder to replace all?" — No.** Wayfinder's own philosophy is "each ticket resolves a decision, not a deliverable"; it explicitly stops where delivery starts, and it is explicitly human-in-the-loop. It cannot replace layer 2, and layer 2 is the only layer that delivers the original goal: _Claude works tickets autonomously (Jira lifecycle, branch/PR/gates) while we're away._ If the team's goal has shifted to attended-only engineering discipline, then layers 1+3 (wayfinder + mattpocock/superpowers) do cover that, and layer 2 becomes optional — that's the real fork in this decision.

## Recommendation per piece

| Piece                                                              | Recommendation                                                    | Why                                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wayfinder` (+ optionally `grill-me`, `to-spec`)                   | **Adopt** as the front end for large/ambiguous work               | We never built this layer; it composes cleanly — wayfinder charts fog into tickets, `/ac` drains tickets. Note: it assumes GitHub-style issue labels/relations; Jira via MCP works partially and needs a trial.         |
| AC delivery skills (4 skills + commands + bindings + ralph prompt) | **Keep, relocate** out of this repo into a standalone skills repo | The bridge is transport, not methodology. The templates are self-contained versioned markdown — extraction is cheap, nothing is wasted.                                                                                 |
| Bindings file (`.claude/ac-bindings.md`)                           | **Keep, per-project**                                             | Irreducibly project-specific (tracker, base branch, ship policy). Lives in each repo regardless of where skills live.                                                                                                   |
| `/installAC` bot command                                           | **Slim or retire**                                                | If skills distribute via the plugin/`npx skills add` path, the installer shrinks to "write the bindings file (+ optional ralph prompt)" — which could equally be a skill-native setup command instead of a bot command. |
| Ralph integration (unattended loop, prompt convention, watchdog)   | **Keep in the bot**                                               | This genuinely is transport/control-plane. It stays regardless of where the skill markdown lives.                                                                                                                       |
| Superpowers vs mattpocock (layer 3)                                | **No action required**                                            | Overlapping stacks with different flavors. AC skills reference these disciplines as "apply if available" — interchangeable underneath.                                                                                  |
| Our attended clarification loop (mini-spec phase)                  | **Optionally defer to `grill-me`**                                | Same job, theirs is battle-tested; ours stays as the fallback when the collection isn't installed.                                                                                                                      |

## The placement question (the team's core concern)

Proposed target architecture:

1. **Standalone skills repo** (e.g. `ac-skills`): the four skills + commands + templates, versioned there, consumable via Claude Code's plugin system (`/plugin install`) or `npx skills add` — the ecosystem-standard path mattpocock/skills itself uses. Updates come from the repo, not from bot releases.
2. **Per project:** only `ac-bindings.md` (+ `plans/prompt_tasks.md` where unattended ralph is wanted).
3. **This bot:** ralph loop control + (optionally) a slimmed bindings-writer command.

### One genuine trade-off the team must pick

- **User-scope plugin install:** skills available in every repo and every worktree automatically, self-updating, simplest. Cost: no hard per-project scoping.
- **Per-repo install (committed files):** hard scoping (a repo without the skills never sees them — the original requirement when this was Kinetix-specific), teammates get them via git. Cost: per-repo upgrade chore.

Now that the skills are generic (all project specifics live in bindings), user-scope is safe and is the lighter choice; per-repo remains right for anything organisation-sensitive. The two can also mix (plugin for the generic set; kx_repo keeps its bespoke committed set until migrated).

## What's already built and transfers as-is

Everything merged on `feat/new-spawn-tmux`: the four generalized skills, bindings/ralph templates (version-stamped), the pure installer module + tests, docs, and two incidental repo fixes (GIT\_\* env scrub in ralph tests; repo config repairs). Extraction = move `templates/ac-pipeline/` to the new repo, repoint or retire the installer. The kx_repo bespoke skills stay untouched either way until a later migration.

## Decision needed from the team

1. Confirm the goal: does unattended ticket delivery (layer 2) still matter? (If yes → keep AC delivery layer; if no → adopt layers 1+3 only.)
2. Approve extraction of the AC skills to a standalone repo, slimming the bot to ralph + bindings-writer.
3. Pick user-scope plugin vs per-repo install as the default distribution.
4. Trial wayfinder on one real piece of large work (suggest: a Jira-based trial to validate the tracker assumptions).
