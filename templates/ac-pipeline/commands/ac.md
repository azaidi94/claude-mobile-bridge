---
description: Run a task through the adaptive AC pipeline (complexity assessment, plan, implement, QA loop, ship)
---

Task: $ARGUMENTS

If no ticket key or goal was given, ask which one before doing anything else.

If `.acp/<task-id>/` already exists for this task, read the Status header in
`plan.md` (or `status.md`) and offer to resume from the recorded phase
instead of starting over.

Otherwise, use the **ac-pipeline** skill and work through its phases in this
session, in order:

1. Intake (read `.claude/ac-bindings.md`, fetch task, branch)
2. Complexity assessment (simple / medium / complex)
3. Mini-spec (complex tasks only)
4. Planning (Plan subagent)
5. Implementation (subtask by subtask)
6. QA loop (QA subagent, max 3 rounds)
7. Ship (per the bindings' Ship policy)

Use your normal judgment and ask before anything risky or ambiguous — this
is an attended, in-session pipeline unless the invoking prompt explicitly
states unattended mode.

<!-- ac-pipeline-version: 1 -->
