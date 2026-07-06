# Bidirectional Shadow (WS-3b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Widen the WS-3a shadow so it also catches the cases that actually matter — where the watcher registry resolved a sessionId that the resolver does NOT reproduce authoritatively — making a clean soak real evidence that the resolver can replace the registry, not just that it copies authoritative ids.

**Architecture:** WS-3a's `shadowCompareIdentities` only walks the resolver's `authoritative` set and checks the registry agrees — the near-tautological half (both sides read `pf.sessionId`). This plan makes the comparison **bidirectional**: it also walks the registry's id-bearing sessions and flags where the resolver returns a different id, no authoritative id, or nothing — i.e. ids the registry produced via its harder `scanSessions` fallback / sibling routing that the resolver didn't reproduce. Still **observe-only**: logs and counts, changes no routing.

**Tech Stack:** TypeScript, Bun test runner.

**Why this before the watcher migration (WS-3c):** the WS-3a final review found "zero divergences" only covers authoritative ids. Migrating the watcher onto the resolver (WS-3c) is behavior-changing and must be gated on a soak that exercises the _registry's_ decisions. This plan provides that soak signal.

## Global Constraints

- OBSERVE-ONLY: the comparison result must not feed routing/resolution. Logs + returned counts only.
- Filter to alive relays (`isProcessAlive`) before resolving — same boundary as WS-3a.
- A real OS PID is ≥ 1; `claudePid <= 0` (absent ppid) is unresolvable — skip it on both sides.
- Reuse `resolveIdentities` (`src/sessions/identity.ts`) and its `ResolvedIdentity` unchanged.
- Logger: `import { warn } from "../logger"`; tests inject a log spy via the function's 2nd arg (no module monkey-patching).
- Divergence kind vocabulary (exact strings):
  - `"registry_resolver_disagree"` — both sides hold an id for the same claudePid and they differ.
  - `"registry_only"` — registry holds an id for a claudePid the resolver does NOT classify authoritative (the key gap: a harder registry decision the resolver missed).
  - `"resolver_only"` — resolver is authoritative for a claudePid the registry has no id for (minor; registry may just be catching up).
- Commit style: no "Generated with Claude Code" / Co-Authored-By trailers.

---

### Task 1: Make `shadowCompareIdentities` bidirectional

**Files:**

- Modify: `src/sessions/identity-shadow.ts`
- Modify: `src/sessions/watcher.ts` (update the call site)
- Modify: `src/__tests__/identity-shadow.test.ts` (replace `registryIdFor` fixtures with `registrySessions`; add the new-direction cases)

**Interfaces:**

- Changed: `function shadowCompareIdentities(input: { portFiles: PortFileData[]; topics: TopicMapping[]; registrySessions: ReadonlyArray<{ claudePid: number; sessionId: string }> }, log?: (msg: string, ctx?: object) => void): { compared: number; divergences: number }`
  - Replaces WS-3a's `registryIdFor` callback with an explicit list of the registry's id-bearing sessions (`claudePid` + non-empty `sessionId`), so both directions can be walked.

- [ ] **Step 1: Rewrite the test to the new signature and add the hard-case tests**

Replace the WS-3a test body (it used `registryIdFor`) with:

```typescript
import { describe, test, expect } from "bun:test";
import { shadowCompareIdentities } from "../sessions/identity-shadow";
import type { PortFileData } from "../relay/discovery";

const relay = (o: Partial<PortFileData>): PortFileData =>
  ({
    port: 1,
    pid: process.pid,
    ppid: 99,
    cwd: "/p",
    startedAt: "2026-01-01T00:00:00Z",
    ...o,
  }) as PortFileData;

describe("shadowCompareIdentities (bidirectional)", () => {
  test("agreement on an authoritative id → no divergence", () => {
    const logs: string[] = [];
    const res = shadowCompareIdentities(
      {
        portFiles: [relay({ ppid: 99, sessionId: "sid-x" })],
        topics: [],
        registrySessions: [{ claudePid: 99, sessionId: "sid-x" }],
      },
      (m) => logs.push(m),
    );
    expect(res.divergences).toBe(0);
    expect(logs.length).toBe(0);
  });

  test("registry and resolver hold different ids for one pid → registry_resolver_disagree", () => {
    const logs: string[] = [];
    const res = shadowCompareIdentities(
      {
        portFiles: [relay({ ppid: 99, sessionId: "sid-resolver" })],
        topics: [],
        registrySessions: [{ claudePid: 99, sessionId: "sid-registry" }],
      },
      (m) => logs.push(m),
    );
    expect(res.divergences).toBe(1);
    expect(logs.some((m) => m.includes("registry_resolver_disagree"))).toBe(
      true,
    );
  });

  test("registry has an id the resolver is not authoritative for → registry_only", () => {
    // Relay has NO sessionId (resolver classifies it 'missing'), but the registry
    // resolved one via its own fallback. This is the gap WS-3b exists to catch.
    const logs: string[] = [];
    const res = shadowCompareIdentities(
      {
        portFiles: [relay({ ppid: 99, sessionId: undefined })],
        topics: [],
        registrySessions: [{ claudePid: 99, sessionId: "sid-registry-only" }],
      },
      (m) => logs.push(m),
    );
    expect(res.divergences).toBe(1);
    expect(logs.some((m) => m.includes("registry_only"))).toBe(true);
  });

  test("resolver authoritative for a pid the registry has no id for → resolver_only", () => {
    const logs: string[] = [];
    const res = shadowCompareIdentities(
      {
        portFiles: [relay({ ppid: 99, sessionId: "sid-resolver" })],
        topics: [],
        registrySessions: [],
      },
      (m) => logs.push(m),
    );
    expect(res.divergences).toBe(1);
    expect(logs.some((m) => m.includes("resolver_only"))).toBe(true);
  });

  test("dead relays are excluded; a registry entry for a dead pid is not 'registry_only'", () => {
    const res = shadowCompareIdentities({
      portFiles: [relay({ pid: 999999, ppid: 99, sessionId: "sid" })],
      topics: [],
      registrySessions: [{ claudePid: 99, sessionId: "sid" }],
    });
    // The dead relay is filtered out, so the resolver yields nothing for pid 99.
    // A registry entry whose pid has no live relay is not the resolver's failure —
    // it must NOT be flagged registry_only. (See Step 3 note.)
    expect(res.divergences).toBe(0);
  });

  test("claudePid <= 0 is skipped on both sides", () => {
    const res = shadowCompareIdentities({
      portFiles: [relay({ ppid: undefined, sessionId: "sid" })],
      topics: [],
      registrySessions: [{ claudePid: 0, sessionId: "sid" }],
    });
    expect(res.compared).toBe(0);
    expect(res.divergences).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test src/__tests__/identity-shadow.test.ts`
Expected: FAIL — the new signature (`registrySessions`) and the new kinds don't exist yet.

- [ ] **Step 3: Implement the bidirectional comparison**

Replace the body of `shadowCompareIdentities` with:

```typescript
import { warn } from "../logger";
import { isProcessAlive, type PortFileData } from "../relay/discovery";
import type { TopicMapping } from "../topics/topic-store";
import { resolveIdentities } from "./identity";

export function shadowCompareIdentities(
  input: {
    portFiles: PortFileData[];
    topics: TopicMapping[];
    registrySessions: ReadonlyArray<{ claudePid: number; sessionId: string }>;
  },
  log: (msg: string, ctx?: object) => void = warn,
): { compared: number; divergences: number } {
  const aliveRelays = input.portFiles.filter((pf) => isProcessAlive(pf.pid));
  const resolved = resolveIdentities({ aliveRelays, topics: input.topics });

  // Resolver's authoritative id per live claudePid (the only ids it asserts).
  const resolverAuthById = new Map<number, string>();
  for (const r of resolved) {
    if (r.claudePid > 0 && r.provenance === "authoritative" && r.sessionId) {
      resolverAuthById.set(r.claudePid, r.sessionId);
    }
  }
  // Which claudePids have a LIVE relay at all (to avoid blaming the resolver for
  // a registry entry whose process is already gone).
  const liveClaudePids = new Set<number>(
    resolved.filter((r) => r.claudePid > 0).map((r) => r.claudePid),
  );
  const registryById = new Map<number, string>();
  for (const s of input.registrySessions) {
    if (s.claudePid > 0 && s.sessionId)
      registryById.set(s.claudePid, s.sessionId);
  }

  const pids = new Set<number>([
    ...resolverAuthById.keys(),
    ...registryById.keys(),
  ]);
  let compared = 0;
  let divergences = 0;
  for (const pid of pids) {
    compared++;
    const resolverId = resolverAuthById.get(pid);
    const registryId = registryById.get(pid);
    let kind: string | null = null;
    if (resolverId && registryId && resolverId !== registryId) {
      kind = "registry_resolver_disagree";
    } else if (registryId && !resolverId && liveClaudePids.has(pid)) {
      kind = "registry_only";
    } else if (resolverId && !registryId) {
      kind = "resolver_only";
    }
    if (kind) {
      divergences++;
      log(`identity-shadow: ${kind}`, {
        claudePid: pid,
        resolver: resolverId ?? null,
        registry: registryId ?? null,
      });
    }
  }
  return { compared, divergences };
}
```

> Note the `liveClaudePids.has(pid)` guard on `registry_only`: a registry session whose Claude process is already dead has no live relay, so the resolver correctly yields nothing — that is not a resolver failure and must not be flagged (the "dead relay" test pins this).

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun test src/__tests__/identity-shadow.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Update the watcher call site**

In `src/sessions/watcher.ts`, change the shadow call to pass `registrySessions` instead of `registryIdFor`:

```typescript
try {
  shadowCompareIdentities({
    portFiles,
    topics: getTopicStore().topics,
    registrySessions: getSessions()
      .filter((s) => s.source === "desktop" && s.id && s.pid)
      .map((s) => ({ claudePid: s.pid!, sessionId: s.id })),
  });
} catch (err) {
  warn(`identity-shadow: comparison failed: ${err}`);
}
```

(`getSessions`, `getTopicStore`, `warn`, `portFiles`, and the `shadowCompareIdentities` import are already in scope from WS-3a.)

- [ ] **Step 6: Verify nothing else broke**

Run: `bun run typecheck`
Expected: clean.
Run: `bun test src/__tests__/identity-shadow.test.ts src/__tests__/identity-resolver.test.ts src/__tests__/session-manager.test.ts src/__tests__/watcher-coalesce.test.ts`
Expected: all PASS. `identity-shadow:` lines (now including `registry_only`) may appear for real machine state — that is the WS-3b signal we want to observe before WS-3c.

- [ ] **Step 7: Commit**

```bash
git add src/sessions/identity-shadow.ts src/sessions/watcher.ts src/__tests__/identity-shadow.test.ts
git commit -m "feat(identity): bidirectional shadow — flag registry ids the resolver doesn't reproduce

WS-3a's shadow only compared the authoritative subset (both sides read the same
pf.sessionId). WS-3b also walks the registry's id-bearing sessions and flags
registry_only (registry resolved an id the resolver isn't authoritative for —
the scanSessions-fallback decisions), registry_resolver_disagree, and resolver_only.
Still observe-only. This is the soak signal WS-3c (watcher migration) gates on."
```

---

## Exit criteria for WS-3c (watcher migration)

Do NOT start WS-3c until the bidirectional shadow has soaked on real traffic — especially fresh same-dir sibling starts — and `registry_only` / `registry_resolver_disagree` counts are **zero** (or every occurrence is understood and explained). `resolver_only` may be non-zero transiently (registry catching up) and is not a blocker on its own. Capture the observed counts in the WS-3c plan.

## Self-review notes

- Spec coverage: closes the WS-3a final-review gap (Important #1) — the shadow now exercises the registry's harder decisions, not just authoritative copies.
- Still observe-only; the watcher wiring only reads `getSessions()`/`getTopicStore()` and discards the result.
- The `liveClaudePids` guard prevents false `registry_only` flags for dead processes — pinned by a test.
- No placeholders; every step carries real code and exact commands.
