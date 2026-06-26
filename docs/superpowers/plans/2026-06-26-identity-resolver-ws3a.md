# Identity Resolver — Shadow Mode (WS-3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Introduce ONE pure module that produces the canonical per-relay session identity (`claudePid ↔ relayPid ↔ cwd ↔ sessionId ↔ provenance`), and run it in **shadow mode** — logging where its answer diverges from the watcher's current resolution — without any consumer depending on it yet.

**Architecture:** Today the "which sessionId for this process/cwd" rule is re-derived in four places with subtly different logic: `watcher.ts` (`resolveSiblingId` + the `scanSessions` fallback loop), `relay/discovery.ts` (`selectRelayTarget`), `relay/backfill.ts` (JSONL claim), and the relay server's `discoverSessionId`. WS-3a extracts the _classification_ rule into `src/sessions/identity.ts` as a pure function and proves it matches reality via shadow logging. Later sub-plans (WS-3b…) migrate each consumer onto it one at a time, behind the WS-1 invariants. This is the strangler-fig first step: add the new thing, prove it, migrate nothing yet.

**Tech Stack:** TypeScript, Bun test runner.

**Why shadow first:** WS-3 touches the most-patched code in the repo (56/73 recent fixes). A behavior-preserving migration is only safe if we can prove the new resolver reproduces current behavior _before_ switching. Shadow mode gives that evidence from real runs; WS-1's invariant logging is already in place to catch regressions.

## Global Constraints

- WS-3a is **additive / observe-only**: no consumer may change behavior. The resolver's output is logged for comparison and otherwise unused.
- Provenance vocabulary (exact strings): `"authoritative"` (sessionId present in the port file — written by the SessionStart hook or the relay's own discovery), `"ambiguous"` (no sessionId and >1 live relay in the same cwd), `"missing"` (no sessionId, lone relay in its cwd — recoverable by backfill). These mirror WS-1's `IdentityViolation` kinds so the two stay coherent.
- Reuse existing types verbatim:
  - `PortFileData` (`src/relay/discovery.ts`): `{ port, pid, ppid, cwd, sessionId?, sessionName?, startedAt, ... }`
  - `SessionInfo` (`src/sessions/types.ts`): `{ id, name, dir, lastActivity, source, pid? }`
  - `TopicMapping` (`src/topics/topic-store.ts` re-export): `{ topicId, sessionName, sessionId, sessionDir, isOnline, createdAt }`
- Reuse `isProcessAlive` from `src/relay/discovery.ts` at the call boundary; the resolver itself stays pure (caller pre-filters alive relays), same discipline as WS-1's `checkIdentityInvariants`.
- Logger: `import { warn, debug } from "../logger"` — `warn(message: string, context?: object)`.
- Bun test runner. Commit style: no "Generated with Claude Code" / Co-Authored-By trailers.

---

### Task 1: Pure `resolveIdentities`

**Files:**

- Create: `src/sessions/identity.ts`
- Test: `src/__tests__/identity-resolver.test.ts`

**Interfaces:**

- Produces:
  - `type IdentityProvenance = "authoritative" | "ambiguous" | "missing"`
  - `type ResolvedIdentity = { claudePid: number; relayPid: number; cwd: string; sessionId: string | null; provenance: IdentityProvenance; topicId: number | null }`
  - `function resolveIdentities(input: { aliveRelays: PortFileData[]; topics: TopicMapping[] }): ResolvedIdentity[]`
- Rules (codify ONCE):
  - One `ResolvedIdentity` per alive relay (`claudePid = pf.ppid`, `relayPid = pf.pid`).
  - `sessionId = pf.sessionId ?? null`. If present → `provenance = "authoritative"`.
  - If absent: `provenance = "ambiguous"` when another alive relay shares `cwd`, else `"missing"`.
  - `topicId`: the topic whose `sessionId` equals this relay's sessionId (only when sessionId is non-null); else `null`. (Never match topics by cwd here — sibling-unsafe by design.)

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, test, expect } from "bun:test";
import { resolveIdentities } from "../sessions/identity";
import type { PortFileData } from "../relay/discovery";
import type { TopicMapping } from "../topics/topic-store";

const relay = (o: Partial<PortFileData>): PortFileData =>
  ({
    port: 1,
    pid: 100,
    ppid: 99,
    cwd: "/p",
    startedAt: "2026-01-01T00:00:00Z",
    ...o,
  }) as PortFileData;
const topic = (o: Partial<TopicMapping>): TopicMapping => ({
  topicId: 1,
  sessionName: "s",
  sessionId: "",
  sessionDir: "/p",
  isOnline: true,
  createdAt: "2026-01-01T00:00:00Z",
  ...o,
});

describe("resolveIdentities", () => {
  test("a relay with a sessionId resolves as authoritative and links its topic", () => {
    const out = resolveIdentities({
      aliveRelays: [
        relay({ pid: 100, ppid: 99, cwd: "/p", sessionId: "sid-a" }),
      ],
      topics: [topic({ topicId: 7, sessionId: "sid-a" })],
    });
    expect(out).toEqual([
      {
        claudePid: 99,
        relayPid: 100,
        cwd: "/p",
        sessionId: "sid-a",
        provenance: "authoritative",
        topicId: 7,
      },
    ]);
  });

  test("a lone id-less relay is 'missing' with no topic", () => {
    const out = resolveIdentities({
      aliveRelays: [relay({ cwd: "/solo", sessionId: undefined })],
      topics: [],
    });
    expect(out[0]!.provenance).toBe("missing");
    expect(out[0]!.sessionId).toBeNull();
    expect(out[0]!.topicId).toBeNull();
  });

  test("two id-less relays in one cwd are both 'ambiguous'", () => {
    const out = resolveIdentities({
      aliveRelays: [
        relay({ pid: 1, ppid: 11, cwd: "/shared", sessionId: undefined }),
        relay({ pid: 2, ppid: 22, cwd: "/shared", sessionId: undefined }),
      ],
      topics: [],
    });
    expect(out.map((r) => r.provenance)).toEqual(["ambiguous", "ambiguous"]);
  });

  test("authoritative siblings in one cwd each link their own topic by sessionId", () => {
    const out = resolveIdentities({
      aliveRelays: [
        relay({ pid: 1, ppid: 11, cwd: "/shared", sessionId: "sid-1" }),
        relay({ pid: 2, ppid: 22, cwd: "/shared", sessionId: "sid-2" }),
      ],
      topics: [
        topic({ topicId: 1, sessionId: "sid-1" }),
        topic({ topicId: 2, sessionId: "sid-2" }),
      ],
    });
    expect(out.find((r) => r.relayPid === 1)!.topicId).toBe(1);
    expect(out.find((r) => r.relayPid === 2)!.topicId).toBe(2);
  });

  test("an id-less relay sharing a cwd with an authoritative one is still 'missing' (only id-less siblings make it ambiguous)", () => {
    const out = resolveIdentities({
      aliveRelays: [
        relay({ pid: 1, ppid: 11, cwd: "/mix", sessionId: "sid-1" }),
        relay({ pid: 2, ppid: 22, cwd: "/mix", sessionId: undefined }),
      ],
      topics: [],
    });
    expect(out.find((r) => r.relayPid === 2)!.provenance).toBe("missing");
  });
});
```

> Note the last case's decision: ambiguity is about _id-less_ siblings competing for the same unknown identity. A sibling that already has an authoritative id doesn't make the id-less one ambiguous — backfill can still safely claim the remaining JSONL. If during implementation this rule feels wrong, STOP and report it as a question rather than guessing — it's the crux of the resolver.

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test src/__tests__/identity-resolver.test.ts`
Expected: FAIL — `resolveIdentities` not exported.

- [ ] **Step 3: Implement `resolveIdentities`**

```typescript
import type { PortFileData } from "../relay/discovery";
import type { TopicMapping } from "../topics/topic-store";

export type IdentityProvenance = "authoritative" | "ambiguous" | "missing";

export type ResolvedIdentity = {
  claudePid: number;
  relayPid: number;
  cwd: string;
  sessionId: string | null;
  provenance: IdentityProvenance;
  topicId: number | null;
};

export function resolveIdentities(input: {
  aliveRelays: PortFileData[];
  topics: TopicMapping[];
}): ResolvedIdentity[] {
  const { aliveRelays, topics } = input;

  // Count id-less relays per cwd to classify ambiguity.
  const idlessByCwd = new Map<string, number>();
  for (const r of aliveRelays) {
    if (!r.sessionId) idlessByCwd.set(r.cwd, (idlessByCwd.get(r.cwd) ?? 0) + 1);
  }

  const topicBySid = new Map<string, number>();
  for (const t of topics)
    if (t.sessionId) topicBySid.set(t.sessionId, t.topicId);

  return aliveRelays.map((r) => {
    const sessionId = r.sessionId ?? null;
    let provenance: IdentityProvenance;
    if (sessionId) provenance = "authoritative";
    else if ((idlessByCwd.get(r.cwd) ?? 0) > 1) provenance = "ambiguous";
    else provenance = "missing";
    return {
      claudePid: r.ppid,
      relayPid: r.pid,
      cwd: r.cwd,
      sessionId,
      provenance,
      topicId: sessionId ? (topicBySid.get(sessionId) ?? null) : null,
    };
  });
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun test src/__tests__/identity-resolver.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sessions/identity.ts src/__tests__/identity-resolver.test.ts
git commit -m "feat(identity): pure resolveIdentities — canonical per-relay identity with provenance"
```

---

### Task 2: Shadow-mode comparison logging

**Files:**

- Create: `src/sessions/identity-shadow.ts`
- Modify: `src/sessions/watcher.ts` (inside `doRefresh`, beside the existing `reportIdentityViolations` call)
- Test: `src/__tests__/identity-shadow.test.ts`

**Interfaces:**

- Consumes: `resolveIdentities` (Task 1), `getSession`/`SessionInfo` (the watcher registry), `isProcessAlive` (`../relay/discovery`).
- Produces: `function shadowCompareIdentities(input: { portFiles: PortFileData[]; topics: TopicMapping[]; registryIdFor: (claudePid: number) => string | undefined }, log?: (msg: string, ctx?: object) => void): { compared: number; divergences: number }`
  — filters to alive relays, runs `resolveIdentities`, and for each authoritative result compares the resolver's `sessionId` to the watcher registry's id for the same `claudePid`. Logs one line per divergence; returns counts (for tests / future metrics). Observe-only.

- [ ] **Step 1: Write the failing test**

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

describe("shadowCompareIdentities", () => {
  test("logs a divergence when the registry id differs from the resolver's authoritative id", () => {
    const logs: Array<[string, unknown]> = [];
    const res = shadowCompareIdentities(
      {
        portFiles: [relay({ ppid: 99, sessionId: "sid-resolver" })],
        topics: [],
        registryIdFor: (pid) => (pid === 99 ? "sid-registry" : undefined),
      },
      (m, c) => logs.push([m, c]),
    );
    expect(res.compared).toBe(1);
    expect(res.divergences).toBe(1);
    expect(logs.some(([m]) => m.startsWith("identity-shadow:"))).toBe(true);
  });

  test("no divergence when registry agrees with the resolver", () => {
    const logs: Array<[string, unknown]> = [];
    const res = shadowCompareIdentities(
      {
        portFiles: [relay({ ppid: 99, sessionId: "sid-x" })],
        topics: [],
        registryIdFor: () => "sid-x",
      },
      (m) => logs.push([m, undefined]),
    );
    expect(res.divergences).toBe(0);
    expect(logs.length).toBe(0);
  });

  test("dead relays are excluded from the comparison", () => {
    const res = shadowCompareIdentities({
      portFiles: [relay({ pid: 999999, ppid: 99, sessionId: "sid" })],
      topics: [],
      registryIdFor: () => "other",
    });
    expect(res.compared).toBe(0);
    expect(res.divergences).toBe(0);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bun test src/__tests__/identity-shadow.test.ts`
Expected: FAIL — `shadowCompareIdentities` not exported.

- [ ] **Step 3: Implement the shadow comparison**

```typescript
import { warn } from "../logger";
import { isProcessAlive, type PortFileData } from "../relay/discovery";
import type { TopicMapping } from "../topics/topic-store";
import { resolveIdentities } from "./identity";

export function shadowCompareIdentities(
  input: {
    portFiles: PortFileData[];
    topics: TopicMapping[];
    registryIdFor: (claudePid: number) => string | undefined;
  },
  log: (msg: string, ctx?: object) => void = warn,
): { compared: number; divergences: number } {
  const aliveRelays = input.portFiles.filter((pf) => isProcessAlive(pf.pid));
  const resolved = resolveIdentities({ aliveRelays, topics: input.topics });
  let compared = 0;
  let divergences = 0;
  for (const r of resolved) {
    if (r.provenance !== "authoritative" || !r.sessionId) continue;
    compared++;
    const registryId = input.registryIdFor(r.claudePid);
    if (registryId && registryId !== r.sessionId) {
      divergences++;
      log("identity-shadow: registry/resolver sessionId divergence", {
        claudePid: r.claudePid,
        cwd: r.cwd,
        resolver: r.sessionId,
        registry: registryId,
      });
    }
  }
  return { compared, divergences };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `bun test src/__tests__/identity-shadow.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into the watcher refresh (observe-only)**

In `src/sessions/watcher.ts`, beside the existing `reportIdentityViolations({...})` call inside `doRefresh`, add:

```typescript
// Shadow-only (WS-3a): does the new resolver reproduce the registry's ids?
try {
  shadowCompareIdentities({
    portFiles,
    topics: getTopicStore().topics,
    registryIdFor: (claudePid) =>
      getSessions().find((s) => s.pid === claudePid)?.id || undefined,
  });
} catch (err) {
  warn(`identity-shadow: comparison failed: ${err}`);
}
```

Add the import at the top of `watcher.ts`:

```typescript
import { shadowCompareIdentities } from "./identity-shadow";
```

(`getSessions`, `getTopicStore`, `warn`, and `portFiles` are already in scope in `doRefresh` — `getSessions().find(s => s.pid === claudePid)` maps the resolver's `claudePid` back to the registry's `SessionInfo.pid`, which the watcher set from `pf.ppid`.)

- [ ] **Step 6: Verify nothing else broke**

Run: `bun run typecheck`
Expected: clean.
Run: `bun test src/__tests__/identity-resolver.test.ts src/__tests__/identity-shadow.test.ts src/__tests__/session-manager.test.ts src/__tests__/watcher-coalesce.test.ts`
Expected: all PASS. `identity-shadow:` lines may appear in the watcher test logs for real machine state — that is the signal we want (or, ideally, none, meaning the resolver already agrees with the registry).

- [ ] **Step 7: Commit**

```bash
git add src/sessions/identity-shadow.ts src/sessions/watcher.ts src/__tests__/identity-shadow.test.ts
git commit -m "feat(identity): shadow-compare resolveIdentities against the watcher registry (observe-only)"
```

---

## Follow-on sub-plans (NOT in WS-3a)

Written once WS-3a has soaked and shadow logs show the resolver agrees with the
registry (zero divergences) on real traffic:

- **WS-3b — Migrate the watcher.** Replace `resolveSiblingId` + the `scanSessions`
  id-assignment with `resolveIdentities`; the resolver becomes the registry's
  source of identity. Guarded by WS-1 invariants + the (now-quiet) shadow log.
- **WS-3c — Migrate `selectRelayTarget`** to consume the resolver's canonical map
  (and its `provenance`/`ambiguous` to make the "refuse to guess" rule explicit).
- **WS-3d — Fold backfill + the relay server's `discoverSessionId`** behind the
  shared rules (the `missing` provenance is exactly backfill's input set).

Each migration is its own behavior-preserving plan, written when reached.

## Self-review notes

- Spec coverage: implements D2's _introduce one resolver with provenance_ — additively, in shadow mode. The consumer migrations (the rest of D2) are the follow-on sub-plans.
- The `provenance` strings align with WS-1's `IdentityViolation` kinds (`ambiguous_siblings` ↔ `ambiguous`, `missing_session_id` ↔ `missing`), keeping the two modules coherent.
- No placeholders; every step carries real code and exact commands.
- The one genuine design judgment (id-less sibling next to an authoritative one = `missing`, not `ambiguous`) is called out in Task 1 Step 1 with an instruction to escalate rather than guess.
