---
description: Investigate a ticket before work starts — root-cause hypothesis with code evidence, affected components, scope of fix
---

Ticket: $ARGUMENTS

If no ticket key was given, ask which one before doing anything else.

Use the **ac-investigate** skill: read the ticket per
`.claude/ac-bindings.md`'s Tracker, trace the actual code, and write an
investigation report to `.acp/investigations/<task-id>.md`. Present the
report in this session.

Offer (but never do unprompted): posting the report to the tracker, or
continuing straight into `/ac <task>` using the report as input.

<!-- ac-pipeline-version: 1 -->
