---
name: ac-ideate
description: Use when discovering improvement opportunities in an area of the project — runs security, performance, and code-quality review lenses over the area and produces ranked findings pre-shaped as tickets, filed only on explicit request.
---

# ac-ideate

Discover concrete, evidenced improvement opportunities in one area of the
project. Tracker access comes from **`.claude/ac-bindings.md`**'s Tracker
field. If that file is missing, stop and tell the user to run `/installAC`
(or write one by hand).

## 1. Resolve the area

Map the requested area to concrete directories by asking the user or
consulting the project's own docs — don't assume a repo-inventory file
exists. Note the matching Standards doc from the bindings, if listed —
every lens reads it.

## 2. Three lenses, parallel subagents

Dispatch three read-only subagents concurrently, one per lens. Each prompt
contains: the area's directories, the Standards doc path (if any), the
lens focus below, and the required output shape.

- **Security lens**: injection (SQL/command/path), authn/authz gaps,
  secret handling (hardcoded credentials, logging secrets), unsafe
  deserialization, missing input validation at service boundaries.
- **Performance lens**: N+1 query patterns, blocking I/O on hot paths,
  unbounded collections/caches, missing pagination, redundant computation
  in loops, chatty cross-service calls.
- **Quality lens**: duplication, dead code, missing tests on critical
  paths, violations of the project's documented standards, error-handling
  gaps (swallowed exceptions, generic catches).

Required output shape per finding: `file:line — impact (high/medium/low) —
what — why it matters — suggested remedy`. **Findings without file/line
evidence are discarded.**

## 3. Merge and rank

Combine into `.acp/ideation/<area>-<YYYY-MM-DD>.md`, deduplicated and
ranked by impact. Each finding pre-shaped as a ticket:

```markdown
### <N>. <Summary line> (impact: high | lens: security)

**Description:** <what and why, with file:line evidence>
**Acceptance criteria:**

- [ ] <testable outcome>

**Suggested priority:** <High/Medium/Low>
```

No time estimates anywhere. Present the top findings in-session.

## 4. File tickets only on request

Before creating anything, search the bindings' Tracker (`jira_search` or
`gh issue list`) for existing tickets covering the same finding — link
instead of duplicating. Then, for each finding the user explicitly picks,
file it per the bindings' Tracker (`jira_create_issue` or `gh issue
create`) with the pre-shaped content. **Never bulk-create; never create
unprompted.**

## Common mistakes

| Problem                          | Fix                                                             |
| -------------------------------- | --------------------------------------------------------------- |
| Findings without evidence        | Discard them — file:line or it didn't happen                    |
| Duplicate tickets                | Search the tracker first, link existing tickets in the report   |
| Bulk-creating tickets            | Only the user's explicit picks, one by one                      |
| Ignoring the Standards doc       | Each lens reads it, if listed — violations are quality findings |
| Time estimates                   | Impact + priority only, never effort                            |
| Missing `.claude/ac-bindings.md` | Stop and tell the user to run /installAC, or write it by hand   |

<!-- ac-pipeline-version: 1 -->
