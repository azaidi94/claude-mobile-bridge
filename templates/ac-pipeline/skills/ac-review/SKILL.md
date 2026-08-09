---
name: ac-review
description: Use when reviewing a pull/merge request — fetches the diff per the bindings' Ship policy platform, reviews against the project's standards, presents ranked findings in-session, and posts comments only after explicit user approval.
---

# ac-review

Review a PR/MR the way a thorough reviewer would. Platform mechanics come
from **`.claude/ac-bindings.md`**'s Ship policy platform. If that file is
missing, stop and tell the user to run `/installAC` (or write one by hand).

## 1. Fetch

- **GitHub**: `gh pr view <number>` for metadata, `gh pr diff <number>` for
  the full diff, `gh pr view <number> --comments` for existing review
  comments (so you don't duplicate feedback already given).
- **Other platforms**: use whatever the project's existing skills/docs
  provide for fetching PR/MR metadata and diffs. If none exist, ask the
  user for the diff or present findings in-session only, without a fetch
  step.

If the diff is large, also read the touched files in the local checkout for
context — the diff alone hides surrounding logic.

## 2. Review

**First** read the bindings' Standards docs, if listed, for the area(s) the
diff touches. Then review the diff through four lenses:

1. **Correctness** — logic errors, broken edge cases, concurrency issues,
   regressions against the surrounding code you read locally.
2. **Standards** — violations of the project's documented conventions
   (layout, error shapes, testing conventions).
3. **Security** — injection, authn/z gaps, secret handling, unsafe
   deserialization.
4. **Tests** — are the new/changed lines covered by tests?

Each finding: `file:line — severity — issue — concrete suggestion`, where
severity is **blocker** (must fix before merge), **should-fix** (strong
recommendation), or **nit** (style/preference).

Skip anything an existing reviewer comment already covers.

## 3. Present in-session

Rank findings by severity and present them with a verdict:

- **approve** — no blockers, nothing that would embarrass the author.
- **needs-work** — blockers or accumulated should-fixes; list what must
  change.

**Hard rule: never post anything to the platform without the user's
explicit approval in this session.** Presenting findings is always safe;
posting is always gated.

## 4. Post (only on approval)

If the user approves posting, and says which findings to include:

- **GitHub**: `gh pr review <number> --comment --body "<summary>"` for a
  general comment; for inline comments, use `gh api` against the PR review
  comments endpoint anchored to the changed file/line.
- **Other platforms**: use whatever the project's existing skills/docs
  provide for posting comments. If none exist, don't guess at an API —
  report the findings and let the user post them.

Post the summary comment last so inline comments exist when it lands.

## Common mistakes

| Problem                                | Fix                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| Reviewing without the standards docs   | Read the bindings' Standards docs first — half the review value is convention enforcement  |
| Duplicating existing reviewer feedback | Fetch existing comments first and skip covered points                                      |
| Posting without approval               | Never — findings in-session first, post only what the user picks                           |
| Guessing at a platform API             | If the project has no existing posting mechanism, report findings instead of inventing one |
| Missing `.claude/ac-bindings.md`       | Stop and tell the user to run /installAC, or write it by hand                              |

<!-- ac-pipeline-version: 1 -->
