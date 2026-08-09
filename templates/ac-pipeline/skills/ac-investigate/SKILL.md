---
name: ac-investigate
description: Use when triaging a ticket before committing to work on it — traces the reported behavior through the actual code, produces a root-cause hypothesis with file/line evidence, affected components, and fix scope, optionally posted back to the tracker.
---

# ac-investigate

Investigate a ticket so the eventual fix starts from evidence, not
guesswork. Tracker access comes from **`.claude/ac-bindings.md`**'s
Tracker field. If that file is missing, stop and tell the user to run
`/installAC` (or write one by hand).

## 1. Read the ticket

Per the bindings' Tracker:

- **jira**: use the project's `jira` MCP tools to fetch the ticket,
  including comments.
- **github**: `gh issue view <number>` for the full issue, including
  comments.
- **none**: the task is the goal described in the invoking prompt/command
  argument — no external fetch.

Extract:

- The reported behavior vs expected behavior.
- Which component the reporter names (treat as a hint, not truth).
- Reproduction hints: environment, payloads, error messages, stack traces.
- Prior discussion — someone may have already half-diagnosed it.

## 2. Trace the code

**Read the actual code before hypothesizing — no speculation without
file/line evidence.**

- Use the project's search tooling to locate the named components; plain
  grep otherwise.
- Follow error messages/stack traces to their throw sites; read the
  surrounding logic, not just the matching line.
- Check git history of suspect files for recent changes correlating with
  when the issue appeared.

## 3. Report

Write `.acp/investigations/<task-id>.md`:

- **Summary** — the issue in two sentences.
- **Root-cause hypothesis** — with a confidence tag: **confirmed** (traced
  end-to-end, reproducible from the code), **likely** (strong evidence,
  one unverified link), or **speculative** (plausible mechanism, needs
  reproduction). Every claim carries `file:line` evidence.
- **Affected components** — modules/services touched by the defect and by
  the fix.
- **Scope of fix** — which files a fix would touch, and whether it's
  contained or crosses component boundaries. **No time estimates.**
- **Open questions** — what would need answering before implementation.

Present the report in-session.

## 4. Offer follow-ups (never unprompted)

- **Post to the tracker**: per the bindings' Tracker (`jira_add_comment` or
  `gh issue comment`) with the report (or a condensed version) — only if
  the user explicitly approves, and show them the text first.
- **Continue into `/ac <task>`** — the report feeds Phase 1 complexity
  assessment directly.

## Common mistakes

| Problem                                       | Fix                                                           |
| --------------------------------------------- | ------------------------------------------------------------- |
| Hypothesizing from the ticket text alone      | Read the code first — every claim needs file/line evidence    |
| Trusting the reporter's component attribution | It's a hint; verify by tracing the code                       |
| Posting to the tracker unprompted             | Always show the comment text and get approval first           |
| Time estimates in the scope section           | Scope in files/components/boundaries, never hours or days     |
| Missing `.claude/ac-bindings.md`              | Stop and tell the user to run /installAC, or write it by hand |

<!-- ac-pipeline-version: 1 -->
