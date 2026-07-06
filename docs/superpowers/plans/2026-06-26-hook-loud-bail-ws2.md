# Hook Reliability (WS-2, reshaped) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the already-installed SessionStart identity hook _observable_ — log every bail with its reason — so a session that silently fails to self-attribute is visible instead of invisible.

**Architecture:** The hook (`hooks/claude-remote-session-id.ts`) currently has six silent `return` points and logs only on success/write-failure. Route every exit through one logged outcome with a reason code, and make the log path env-overridable so the behavior is testable. Pure logic (`ancestryChain`/`selectPortFile`/`mergeSessionId`) is unchanged.

**Tech Stack:** TypeScript (Bun), runs as a Claude Code SessionStart hook.

## Diagnosis (why this plan exists)

Root cause of the 2026-06-26 incident (kinetix siblings had no `sessionId`):

- The hook fires once at SessionStart, early. On a **fresh start** the channel-relay MCP server usually hasn't written its port file yet, so `selectPortFile` finds no ancestry-matched port file for the session's own `(claudePid, cwd)` → `return` at `claude-remote-session-id.ts:218` with **no log**. No retry past the one-shot hook.
- Evidence: across 39 successful writes (Jun 10–25), only **2** were `source=startup`; **37** were `resume`/`clear`/`compact` (relay already up). A manual smoke-run with a non-ancestry cwd exited 0 and wrote **zero** log lines — the silent bail reproduced.
- Structural ancestry is sound (relay `ppid` = Claude pid = hook ancestor), so this is a **timing race**, not a structural miss.

**Scope decision (YAGNI):** This plan does the _observability_ half only (make bails loud). It deliberately does **not** add a retry/background-poll to win the startup race, because the channel-relay server already self-discovers its own `sessionId` with a retry loop (`server.ts` `discoverSessionId` + `DISCOVERY_RETRY_DELAYS_MS`/`REDISCOVERY_POLL_MS`), and today's `b4cfc80` fixed the encoder that was breaking that self-discovery for `_`/`.` paths. So at startup the relay now self-populates within ~15s, and WS-1 surfaces any residual gap. Adding a second retrying writer in the hook would duplicate that recovery. If, after this lands, the logs show startup bails that the relay self-discovery does NOT then recover, revisit a hook retry as a follow-up — with evidence, not speculation.

## Global Constraints

- A SessionStart hook MUST: never write to stdout (it's injected into Claude's context); always `exit 0`; finish fast (one `ps` + one readdir). The new logging must not violate these — it appends to a file, no stdout, no new blocking work.
- Log path today: hardcoded `~/.claude/logs/session-id-hook.log` (`claude-remote-session-id.ts:57`). Make it `process.env.CLAUDE_SESSION_ID_HOOK_LOG ?? <default>` so tests can point it at a temp file.
- Keep existing successful-write log line format unchanged (other tooling/greps depend on `updated <file> sessionId=<id> (was <x>) source=<s>`).
- Bun test runner. Commit style: no "Generated with Claude Code" / Co-Authored-By trailers.

---

### Task 1: Env-overridable log path + reason-coded bail logging

**Files:**

- Modify: `hooks/claude-remote-session-id.ts`
- Test: `src/__tests__/session-id-hook-logging.test.ts`

**Interfaces:**

- Produces (exported for testing): `type HookOutcome = "updated" | "noop_already_current" | "write_failed" | "bail_bad_stdin" | "bail_missing_fields" | "bail_no_port_files" | "bail_no_ancestry_match" | "bail_reread_failed"`
- Produces: `function decideOutcome(input: { parsed: boolean; sessionId?: string; cwd?: string; candidateCount: number; target?: HookPortFile; currentSessionId?: string }): HookOutcome` — pure mapping from situation to outcome code, so the bail taxonomy is unit-testable without spawning a process.

- [ ] **Step 1: Write the failing pure-logic test**

```typescript
import { describe, test, expect } from "bun:test";
import { decideOutcome } from "../../hooks/claude-remote-session-id";

describe("decideOutcome", () => {
  test("unparseable stdin → bail_bad_stdin", () => {
    expect(decideOutcome({ parsed: false, candidateCount: 0 })).toBe(
      "bail_bad_stdin",
    );
  });
  test("missing sessionId/cwd → bail_missing_fields", () => {
    expect(decideOutcome({ parsed: true, cwd: "/p", candidateCount: 1 })).toBe(
      "bail_missing_fields",
    );
    expect(
      decideOutcome({ parsed: true, sessionId: "s", candidateCount: 1 }),
    ).toBe("bail_missing_fields");
  });
  test("no port files → bail_no_port_files", () => {
    expect(
      decideOutcome({
        parsed: true,
        sessionId: "s",
        cwd: "/p",
        candidateCount: 0,
      }),
    ).toBe("bail_no_port_files");
  });
  test("no ancestry-matched target → bail_no_ancestry_match", () => {
    expect(
      decideOutcome({
        parsed: true,
        sessionId: "s",
        cwd: "/p",
        candidateCount: 3,
      }),
    ).toBe("bail_no_ancestry_match");
  });
  test("target already has this sessionId → noop_already_current", () => {
    const target = { file: "/x", cwd: "/p", ppid: 1 };
    expect(
      decideOutcome({
        parsed: true,
        sessionId: "s",
        cwd: "/p",
        candidateCount: 3,
        target,
        currentSessionId: "s",
      }),
    ).toBe("noop_already_current");
  });
  test("target with a different/absent id → updated", () => {
    const target = { file: "/x", cwd: "/p", ppid: 1 };
    expect(
      decideOutcome({
        parsed: true,
        sessionId: "s",
        cwd: "/p",
        candidateCount: 3,
        target,
        currentSessionId: "old",
      }),
    ).toBe("updated");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bun test src/__tests__/session-id-hook-logging.test.ts`
Expected: FAIL — `decideOutcome` not exported.

- [ ] **Step 3: Implement `decideOutcome` and the env-overridable log path; route `main()` through them**

Add the exported type + function:

```typescript
export type HookOutcome =
  | "updated"
  | "noop_already_current"
  | "write_failed"
  | "bail_bad_stdin"
  | "bail_missing_fields"
  | "bail_no_port_files"
  | "bail_no_ancestry_match"
  | "bail_reread_failed";

export function decideOutcome(input: {
  parsed: boolean;
  sessionId?: string;
  cwd?: string;
  candidateCount: number;
  target?: HookPortFile;
  currentSessionId?: string;
}): HookOutcome {
  if (!input.parsed) return "bail_bad_stdin";
  if (!input.sessionId || !input.cwd) return "bail_missing_fields";
  if (input.candidateCount === 0) return "bail_no_port_files";
  if (!input.target) return "bail_no_ancestry_match";
  if (input.currentSessionId === input.sessionId) return "noop_already_current";
  return "updated";
}
```

Change the log path constant:

```typescript
const LOG_FILE =
  process.env.CLAUDE_SESSION_ID_HOOK_LOG ??
  join(homedir(), ".claude", "logs", "session-id-hook.log");
```

Refactor `main()` so each former silent `return` first computes the outcome and logs a concise reason line, e.g. for the bails:

```typescript
logLine(
  `bail reason=${outcome} cwd=${cwd ?? "?"} candidates=${candidates.length} source=${input.source ?? "?"}`,
);
```

Keep the existing `updated …` success line and the `write failed …` line exactly as they are. The `noop_already_current` case logs at most a terse line (or stays silent to avoid churn — but if silent, comment WHY). Ensure stdout is still never written and the process still always `exit 0`.

- [ ] **Step 4: Run the pure-logic test, verify it passes**

Run: `bun test src/__tests__/session-id-hook-logging.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Add an integration test that the hook logs a bail (env-overridden log)**

```typescript
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

test("hook logs a bail reason for a non-ancestry cwd (integration)", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "sidhook-"));
  const logFile = join(logDir, "hook.log");
  const stateDir = mkdtempSync(join(tmpdir(), "sidhook-state-"));
  const proc = Bun.spawn(
    [
      "bun",
      join(import.meta.dir, "..", "..", "hooks", "claude-remote-session-id.ts"),
    ],
    {
      stdin: Buffer.from(
        JSON.stringify({
          session_id: "x",
          cwd: "/no/such/ancestry/cwd",
          source: "startup",
        }),
      ),
      env: {
        ...process.env,
        CLAUDE_SESSION_ID_HOOK_LOG: logFile,
        CLAUDE_TELEGRAM_STATE_DIR: stateDir, // empty → bail_no_port_files
      },
    },
  );
  const code = await proc.exited;
  expect(code).toBe(0); // hook always exits 0
  expect(existsSync(logFile)).toBe(true);
  const log = readFileSync(logFile, "utf-8");
  expect(log).toContain("bail reason=bail_no_port_files");
});
```

- [ ] **Step 6: Run the integration test, verify it passes**

Run: `bun test src/__tests__/session-id-hook-logging.test.ts`
Expected: PASS (7 tests total). The empty `CLAUDE_TELEGRAM_STATE_DIR` makes `readPortFiles` return `[]` → `bail_no_port_files`, proving the loud-bail path end-to-end.

- [ ] **Step 7: Commit**

```bash
git add hooks/claude-remote-session-id.ts src/__tests__/session-id-hook-logging.test.ts
git commit -m "fix(hook): log every session-id hook bail with a reason code

The SessionStart identity hook had six silent return points and logged only
on success, so a session that failed to self-attribute (the startup race where
the relay port file isn't written yet) was invisible — the root cause of the
2026-06-26 kinetix sibling incident being undiagnosable from logs. Route every
exit through a reason-coded log line and make the log path env-overridable for
testing. Pure ancestry/select logic unchanged; still stdout-silent, still exit 0."
```

---

## Verification after merge (operator)

With the hook now loud, restart or `/clear` a fresh same-dir sibling and confirm:

- a `bail reason=…` or `updated …` line appears in `~/.claude/logs/session-id-hook.log` for it, and
- whether the relay self-discovery (`b4cfc80`) then populates the `sessionId` within ~15s when the hook bailed at startup.

If startup bails are NOT recovered by relay self-discovery, open a follow-up for a bounded hook retry (the deferred half) — now with log evidence to justify it.

## Self-review notes

- Spec coverage: implements the _detection_ half of D1 for the hook itself (loud bails), complementing WS-1's store-level detection.
- The retry/race-fix is explicitly deferred with a stated, evidence-based rationale (relay self-discovery already retries), not forgotten.
- No placeholder steps; every step carries real code and exact commands.
