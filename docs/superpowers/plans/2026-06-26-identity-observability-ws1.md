# Identity Observability (WS-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session-identity disagreement _visible_ — a pure invariant
checker plus loud logging — without changing any resolution behavior, so the
real failure rate can be measured before WS-3 touches the resolution code.

**Architecture:** A new pure module `src/sessions/identity-invariants.ts` takes
the three live identity views (watcher `SessionInfo[]`, topic-store
`TopicMapping[]`, relay `PortFileData[]`) and returns a list of structured
`IdentityViolation`s. A thin reporter logs them. The reporter is called once per
watcher refresh. Nothing reads the result to make decisions yet — WS-1 is
observe-only.

**Tech Stack:** TypeScript, Bun test runner. Source of the spec:
`docs/superpowers/specs/2026-06-26-session-identity-consolidation.md` (decisions
D1 detection-half and D4).

## Global Constraints

- Test runner: `bun test <file>` (isolated suite is `bun run test:isolated`).
- Logger API: `import { warn } from "../logger"`; signature `warn(message: string, context?: object)`.
- WS-1 is **observe-only**: no task may change which session anything routes to.
- Types are fixed by existing code — copy verbatim:
  - `SessionInfo` (`src/sessions/types.ts`): `{ id: string; name: string; dir: string; lastActivity: number; source: "telegram"|"desktop"|"cursor"; pid?: number }`
  - `TopicMapping` (`src/topics/topic-store.ts`): `{ topicId: number; sessionName: string; sessionId: string; sessionDir: string; isOnline: boolean; createdAt: string }`
  - `PortFileData` (`src/relay/discovery.ts`): has at least `{ port: number; pid: number; ppid: number; cwd: string; sessionId?: string; sessionName?: string; startedAt: string }`
- Commit style: no "Generated with Claude Code" / Co-Authored-By trailers.

---

### Task 1: Pure identity-invariant checker

**Files:**

- Create: `src/sessions/identity-invariants.ts`
- Test: `src/__tests__/identity-invariants.test.ts`

**Interfaces:**

- Produces:
  - `type IdentityViolation = { kind: "duplicate_topic_for_session" | "store_disagreement" | "missing_session_id" | "ambiguous_siblings"; sessionId?: string; sessionName?: string; cwd?: string; detail: string }`
  - `function checkIdentityInvariants(input: { sessions: SessionInfo[]; topics: TopicMapping[]; aliveRelays: PortFileData[] }): IdentityViolation[]`
- Note: `aliveRelays` are pre-filtered to live processes by the caller, so the
  checker stays pure (no `ps`/`isProcessAlive` inside).

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, test, expect } from "bun:test";
import { checkIdentityInvariants } from "../sessions/identity-invariants";
import type { SessionInfo } from "../sessions/types";
import type { TopicMapping } from "../topics/topic-store";
import type { PortFileData } from "../relay/discovery";

const sess = (o: Partial<SessionInfo>): SessionInfo => ({
  id: "",
  name: "s",
  dir: "/p",
  lastActivity: 0,
  source: "desktop",
  ...o,
});
const topic = (o: Partial<TopicMapping>): TopicMapping => ({
  topicId: 1,
  sessionName: "s",
  sessionId: "",
  sessionDir: "/p",
  isOnline: true,
  createdAt: "2026-01-01T00:00:00Z",
  ...o,
});
const relay = (o: Partial<PortFileData>): PortFileData =>
  ({
    port: 1,
    pid: 10,
    ppid: 9,
    cwd: "/p",
    startedAt: "2026-01-01T00:00:00Z",
    ...o,
  }) as PortFileData;

describe("checkIdentityInvariants", () => {
  test("clean state yields no violations", () => {
    const out = checkIdentityInvariants({
      sessions: [sess({ name: "a", id: "id-a" })],
      topics: [topic({ sessionName: "a", sessionId: "id-a" })],
      aliveRelays: [relay({ sessionName: "a", sessionId: "id-a" })],
    });
    expect(out).toEqual([]);
  });

  test("flags two topics claiming the same sessionId", () => {
    const out = checkIdentityInvariants({
      sessions: [],
      topics: [
        topic({ topicId: 1, sessionName: "a", sessionId: "dup" }),
        topic({ topicId: 2, sessionName: "b", sessionId: "dup" }),
      ],
      aliveRelays: [],
    });
    expect(out.map((v) => v.kind)).toContain("duplicate_topic_for_session");
    expect(
      out.find((v) => v.kind === "duplicate_topic_for_session")?.sessionId,
    ).toBe("dup");
  });

  test("flags topic-store vs port-file sessionId disagreement for same name", () => {
    const out = checkIdentityInvariants({
      sessions: [],
      topics: [topic({ sessionName: "a", sessionId: "id-store" })],
      aliveRelays: [relay({ sessionName: "a", sessionId: "id-port" })],
    });
    expect(out.map((v) => v.kind)).toContain("store_disagreement");
  });

  test("flags a lone live relay with no sessionId as missing (recoverable)", () => {
    const out = checkIdentityInvariants({
      sessions: [],
      topics: [],
      aliveRelays: [relay({ cwd: "/solo", sessionId: undefined })],
    });
    expect(out.map((v) => v.kind)).toContain("missing_session_id");
  });

  test("flags id-less same-cwd siblings as ambiguous, not missing", () => {
    const out = checkIdentityInvariants({
      sessions: [],
      topics: [],
      aliveRelays: [
        relay({ pid: 1, cwd: "/shared", sessionId: undefined }),
        relay({ pid: 2, cwd: "/shared", sessionId: undefined }),
      ],
    });
    const kinds = out.map((v) => v.kind);
    expect(kinds).toContain("ambiguous_siblings");
    expect(kinds).not.toContain("missing_session_id");
  });

  test("registry id disagreeing with topic id for same name is flagged", () => {
    const out = checkIdentityInvariants({
      sessions: [sess({ name: "a", id: "id-reg" })],
      topics: [topic({ sessionName: "a", sessionId: "id-top" })],
      aliveRelays: [],
    });
    expect(out.map((v) => v.kind)).toContain("store_disagreement");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/identity-invariants.test.ts`
Expected: FAIL — `Export named 'checkIdentityInvariants' not found` (module missing).

- [ ] **Step 3: Write the minimal implementation**

```typescript
import type { SessionInfo } from "./types";
import type { TopicMapping } from "../topics/topic-store";
import type { PortFileData } from "../relay/discovery";

export type IdentityViolation = {
  kind:
    | "duplicate_topic_for_session"
    | "store_disagreement"
    | "missing_session_id"
    | "ambiguous_siblings";
  sessionId?: string;
  sessionName?: string;
  cwd?: string;
  detail: string;
};

export function checkIdentityInvariants(input: {
  sessions: SessionInfo[];
  topics: TopicMapping[];
  aliveRelays: PortFileData[];
}): IdentityViolation[] {
  const { sessions, topics, aliveRelays } = input;
  const out: IdentityViolation[] = [];

  // I1: no sessionId may back two topics.
  const topicsBySid = new Map<string, TopicMapping[]>();
  for (const t of topics) {
    if (!t.sessionId) continue;
    const arr = topicsBySid.get(t.sessionId) ?? [];
    arr.push(t);
    topicsBySid.set(t.sessionId, arr);
  }
  for (const [sid, ts] of topicsBySid) {
    if (ts.length > 1) {
      out.push({
        kind: "duplicate_topic_for_session",
        sessionId: sid,
        detail: `sessionId ${sid} maps to ${ts.length} topics: ${ts
          .map((t) => t.topicId)
          .join(", ")}`,
      });
    }
  }

  // I2/I4: for a given sessionName, the topic-store id, registry id, and live
  // port-file id must agree (when each is present and non-empty).
  const names = new Set<string>([
    ...topics.map((t) => t.sessionName),
    ...sessions.map((s) => s.name),
    ...aliveRelays.flatMap((r) => (r.sessionName ? [r.sessionName] : [])),
  ]);
  for (const name of names) {
    const ids = new Set<string>();
    const topId = topics.find((t) => t.sessionName === name)?.sessionId;
    const regId = sessions.find((s) => s.name === name)?.id;
    const portId = aliveRelays.find((r) => r.sessionName === name)?.sessionId;
    for (const id of [topId, regId, portId]) if (id) ids.add(id);
    if (ids.size > 1) {
      out.push({
        kind: "store_disagreement",
        sessionName: name,
        detail: `name ${name} has divergent ids — topic=${topId ?? "∅"} registry=${regId ?? "∅"} port=${portId ?? "∅"}`,
      });
    }
  }

  // I3: a live relay with no sessionId. Lone → recoverable "missing"; one of
  // several in the same cwd → "ambiguous" (must never be guessed across).
  const relaysByCwd = new Map<string, PortFileData[]>();
  for (const r of aliveRelays) {
    const arr = relaysByCwd.get(r.cwd) ?? [];
    arr.push(r);
    relaysByCwd.set(r.cwd, arr);
  }
  for (const r of aliveRelays) {
    if (r.sessionId) continue;
    const siblings = relaysByCwd.get(r.cwd)!.length;
    if (siblings > 1) {
      out.push({
        kind: "ambiguous_siblings",
        cwd: r.cwd,
        detail: `${siblings} live relays in ${r.cwd} lack a sessionId; cannot disambiguate without the SessionStart hook`,
      });
    } else {
      out.push({
        kind: "missing_session_id",
        cwd: r.cwd,
        detail: `live relay pid=${r.pid} in ${r.cwd} has no sessionId (hook missing or JSONL not yet discovered)`,
      });
    }
  }

  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/identity-invariants.test.ts`
Expected: PASS (6 tests). Note: the ambiguous-siblings test asserts no duplicate
`ambiguous_siblings` rows are required — if the loop emits one per relay, dedupe
by cwd (see Step 5).

- [ ] **Step 5: Refactor — dedupe ambiguous rows by cwd, keep tests green**

If Step 4 shows two `ambiguous_siblings` rows for one cwd, collapse them: track a
`Set<string>` of cwds already reported and `continue` if seen. Re-run Step 4.

- [ ] **Step 6: Commit**

```bash
git add src/sessions/identity-invariants.ts src/__tests__/identity-invariants.test.ts
git commit -m "feat(identity): pure invariant checker for session-id disagreement"
```

---

### Task 2: Reporter — log violations once per refresh

**Files:**

- Create: `src/sessions/identity-report.ts`
- Modify: `src/sessions/watcher.ts` (inside `doRefresh`, after `scanSessions`)
- Test: `src/__tests__/identity-report.test.ts`

**Interfaces:**

- Consumes: `checkIdentityInvariants` (Task 1), `isProcessAlive` (`../relay/discovery`).
- Produces: `function reportIdentityViolations(input: { sessions: SessionInfo[]; topics: TopicMapping[]; portFiles: PortFileData[] }): IdentityViolation[]`
  — filters `portFiles` to alive, runs the checker, logs each violation via
  `warn("identity: <kind>", {...})`, and returns the list (for tests / future use).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as logger from "../logger";
import { reportIdentityViolations } from "../sessions/identity-report";
import type { PortFileData } from "../relay/discovery";

const relay = (o: Partial<PortFileData>): PortFileData =>
  ({
    port: 1,
    pid: process.pid,
    ppid: 9,
    cwd: "/p",
    startedAt: "2026-01-01T00:00:00Z",
    ...o,
  }) as PortFileData;

describe("reportIdentityViolations", () => {
  let warns: Array<[string, unknown]>;
  let orig: typeof logger.warn;
  beforeEach(() => {
    warns = [];
    orig = logger.warn;
    // @ts-expect-error test override
    logger.warn = (msg: string, ctx?: unknown) => warns.push([msg, ctx]);
  });
  afterEach(() => {
    // @ts-expect-error restore
    logger.warn = orig;
  });

  test("logs a warn line for a missing-sessionId live relay", () => {
    const out = reportIdentityViolations({
      sessions: [],
      topics: [],
      // pid=process.pid so isProcessAlive() passes
      portFiles: [relay({ cwd: "/solo", sessionId: undefined })],
    });
    expect(out.map((v) => v.kind)).toContain("missing_session_id");
    expect(warns.some(([m]) => m.startsWith("identity:"))).toBe(true);
  });

  test("dead relays are filtered out before checking", () => {
    const out = reportIdentityViolations({
      sessions: [],
      topics: [],
      portFiles: [relay({ pid: 999999, cwd: "/solo", sessionId: undefined })],
    });
    expect(out).toEqual([]);
    expect(warns.length).toBe(0);
  });
});
```

> If runtime `logger.warn` reassignment doesn't take (ESM binding), fall back to
> dependency injection: give `reportIdentityViolations` an optional
> `log: (m: string, c?: object) => void = warn` parameter and pass a spy in the
> test. Prefer DI if the monkey-patch is flaky.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/identity-report.test.ts`
Expected: FAIL — `Export named 'reportIdentityViolations' not found`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
import { warn } from "../logger";
import { isProcessAlive, type PortFileData } from "../relay/discovery";
import type { SessionInfo } from "./types";
import type { TopicMapping } from "../topics/topic-store";
import {
  checkIdentityInvariants,
  type IdentityViolation,
} from "./identity-invariants";

export function reportIdentityViolations(
  input: {
    sessions: SessionInfo[];
    topics: TopicMapping[];
    portFiles: PortFileData[];
  },
  log: (msg: string, ctx?: object) => void = warn,
): IdentityViolation[] {
  const aliveRelays = input.portFiles.filter((pf) => isProcessAlive(pf.pid));
  const violations = checkIdentityInvariants({
    sessions: input.sessions,
    topics: input.topics,
    aliveRelays,
  });
  for (const v of violations) {
    log(`identity: ${v.kind}`, {
      detail: v.detail,
      sessionId: v.sessionId,
      sessionName: v.sessionName,
      cwd: v.cwd,
    });
  }
  return violations;
}
```

> Implements the DI form from the test note (default arg = real `warn`), which is
> robust regardless of ESM binding behavior. Update the test to pass a spy as the
> second arg instead of monkey-patching if needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/identity-report.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire into the watcher refresh (observe-only)**

In `src/sessions/watcher.ts`, inside `doRefresh`, AFTER the
`const { sessions: discovered, portFiles } = await scanSessions();` line and
after the registry is rebuilt (use the final resolved session list + the live
topic store), add:

```typescript
// Observe-only (WS-1): surface identity disagreement; changes no routing.
try {
  reportIdentityViolations({
    sessions: getSessions(),
    topics: getTopicStore().topics,
    portFiles,
  });
} catch (err) {
  warn(`identity: invariant check failed: ${err}`);
}
```

Add the import at the top of `watcher.ts`:

```typescript
import { reportIdentityViolations } from "./identity-report";
```

(`getTopicStore` is already imported; `getSessions` is defined in this file.)

- [ ] **Step 6: Verify nothing else broke**

Run: `bun run typecheck`
Expected: clean.
Run: `bun test src/__tests__/identity-invariants.test.ts src/__tests__/identity-report.test.ts src/__tests__/session-manager.test.ts src/__tests__/watcher-coalesce.test.ts`
Expected: all PASS, and `identity:` warn lines may appear in the watcher test
logs for the real machine state (informational, not failures).

- [ ] **Step 7: Commit**

```bash
git add src/sessions/identity-report.ts src/sessions/watcher.ts src/__tests__/identity-report.test.ts
git commit -m "feat(identity): log invariant violations each watcher refresh (observe-only)"
```

---

## Follow-on plans (not in this WS-1 plan)

Written once WS-1 is merged and its logs show the real failure distribution:

- **WS-2 — Guarantee the hook (D1 install-half).** Auto-merge the `SessionStart`
  block into the user's global `~/.claude/settings.json` from `install-hooks`
  (the user approved global scope), replacing the manual README step. Needs a
  JSON merge-not-replace step and an idempotency test.
- **WS-3 — Single Identity Resolver (D2).** Extract one resolver with a
  `provenance` field; re-point watcher/discovery/backfill/AUQ at it.
- **WS-4 — Adversarial resolver tests (§6).** Property + scenario matrix.
- **WS-5 — One-encoder CI guard (D3).**
- **WS-6 — Soak then prune the fallback (D5).** Gated on WS-1 metrics.

## Self-review notes

- Spec coverage: this plan implements D4 (invariant checks) and the _detection_
  half of D1 (`missing_session_id` / `ambiguous_siblings` surface a hookless
  live session). The _install_ half of D1 is WS-2.
- No placeholders: all steps carry real code and exact commands.
- Type consistency: `IdentityViolation`, `checkIdentityInvariants`, and
  `reportIdentityViolations` signatures match between Tasks 1 and 2.
