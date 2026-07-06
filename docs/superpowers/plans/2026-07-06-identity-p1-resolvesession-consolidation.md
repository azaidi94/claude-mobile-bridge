# Identity P1 — `resolveSession` Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate every "which session is this" identify/find call site behind ONE canonical resolver, `resolveSession(handle)`, as a pure behavior-preserving refactor — verified non-regressive by shadow mode before any call site is migrated. No uuid, no hook change, no fallback deletion — those are P2/P3.

**Architecture:** Introduce a single identity brain `resolveSession(handle) → { status: 'resolved', record } | { status: 'pending' } | { status: 'miss' }` where `handle` is a discriminated union over {launchId?, sessionId, pid, cwd, topicId}. In P1 it is a FACADE that delegates to today's logic (`resolveIdentities` + each site's current fallback policy) — same answers, one door. Specialized lookups (topicId, tmux pane, tty, jsonl path, relay port) become thin accessors reading fields off the resolved `SessionRecord`. Each call site is migrated only after a shadow comparator logs ZERO divergence between the site's current answer and `resolveSession`'s answer over a soak. This extends the existing WS-3 `resolveIdentities` (`src/sessions/identity.ts`) and the WS-3b shadow harness (`src/sessions/identity-shadow.ts`); it does not fork them.

**Tech Stack:** TypeScript (Bun test runner). Pure functions + existing watcher/shadow plumbing.

## Global Constraints

- **Behavior-preserving.** P1 changes NO routing outcome. Every `resolveSession` answer must equal what the migrated call site returns today, including its fallback policy. If shadow shows any divergence, fix `resolveSession` — never "fix" the site to match.
- **Fallback policies differ per site and MUST be preserved individually** (from the audit): inject resolvers REFUSE-on-ambiguous (positive identity); `selectRelayTarget` returns `alive[0]` on empty selector and cwd-single-match else null; watch gates newest-in-dir OFF when siblings share the dir; offline/history SCAN by mtime. `resolveSession` encodes these as explicit, named policies — it does not flatten them.
- **EXEMPT from P1 (do NOT migrate):** read-only historical / offline discovery — `src/sessions/offline.ts` (`listOfflineSessions`, `findNewestJsonlInDir`), `src/sessions/history.ts` (`findLatestJsonlForDir` dir-fallback). These serve sessions with no live record and must keep scanning. `resolveSession` is for LIVE sessions only.
- **No new external id yet.** `SessionRecord.launchId` field EXISTS in the type but in P1 is always `null` (populated in P2). Nothing may key on it in P1.
- **Three-state result is load-bearing:** `pending` (entry not yet converged — spawn race, port file not written) is DISTINCT from `miss` (no such session). Preserves the current 6s spawn poll semantics (`session-builder.ts`). A site that today retries on not-found maps not-found → `pending`; a site that today refuses maps ambiguous → `miss`.
- Test runner: `bun test`. Run a single file with `bun test path/to/file.test.ts`.
- Existing types to reuse verbatim: `PortFileData` (`src/relay/discovery.ts:17`), `ResolvedIdentity`/`resolveIdentities` (`src/sessions/identity.ts`), `SessionInfo` (`src/sessions/types.ts:12`), `TopicMapping` (`src/topics/topic-store.ts`).

---

## File Structure

- **Create `src/sessions/resolve-session.ts`** — the canonical resolver: `Handle`, `SessionRecord`, `Resolution` types; `resolveSession()`; the thin accessors (`topicIdFor`, `relayPortFor`, `paneFor`, `ttyKeyFor`, `jsonlPathFor`). Pure over an injected snapshot (alive relays, topics, running procs) — no IO of its own, so it is unit-testable and shadow-runnable.
- **Create `src/sessions/resolve-session.test.ts`** — behavior tests: one per preserved fallback policy, plus pending/miss.
- **Modify `src/sessions/identity-shadow.ts`** — add `shadowResolveSession(site, currentAnswer, handle, snapshot)` that logs a reason-coded divergence when `resolveSession(handle)` ≠ `currentAnswer`. Reuses the existing divergence-logging style.
- **Modify each call site (one task each)** — first wrap in shadow (no behavior change), soak, then migrate the site to read `resolveSession`.
- **Modify `src/sessions/resolve-session.ts` snapshot builder** — a `buildResolveSnapshot()` that the watcher's `doRefresh` populates once per tick (so sites don't each re-scan).

Migration order (lowest-risk first, each independently gated): `selectRelayTarget` → `getTopicBySession`/`getThreadId` (name→record) → inject `resolveTmuxTarget`/`resolveCmuxWorkspace` → watch `_resolveDriftTargetId`/`_resolveLiveJsonlPath`. `getSessionByTopic` (already topicId-keyed, CLEAN) and `findSessionJsonlPath` (already pure id lookup) become accessors with no policy change.

---

### Task 1: Core types — `Handle`, `SessionRecord`, `Resolution`

**Files:**

- Create: `src/sessions/resolve-session.ts`
- Test: `src/sessions/resolve-session.test.ts`

**Interfaces:**

- Produces:
  - `type Handle = {by:'sessionId',sessionId:string} | {by:'pid',pid:number} | {by:'cwd',cwd:string} | {by:'topicId',topicId:number} | {by:'launchId',launchId:string}`
  - `interface SessionRecord { launchId: string | null; sessionId: string | null; claudePid: number; cwd: string; relayPort: number | null; relayPid: number | null; topicId: number | null; tmuxPane: string | null; tmuxSocket: string | null; cmuxWorkspaceId: string | null; provenance: IdentityProvenance; }`
  - `type Resolution = { status:'resolved'; record: SessionRecord } | { status:'pending' } | { status:'miss' }`

- [ ] **Step 1: Write the failing test**

Create `src/sessions/resolve-session.test.ts`:

```ts
import { test, expect } from "bun:test";
import { makeRecord, type SessionRecord } from "./resolve-session";

test("makeRecord defaults launchId to null (P1: never populated)", () => {
  const r: SessionRecord = makeRecord({
    sessionId: "s1",
    claudePid: 100,
    cwd: "/a",
    relayPort: 5,
    relayPid: 6,
    topicId: 42,
    tmuxPane: "%1",
    tmuxSocket: "claude",
    cmuxWorkspaceId: null,
    provenance: "authoritative",
  });
  expect(r.launchId).toBeNull();
  expect(r.sessionId).toBe("s1");
  expect(r.topicId).toBe(42);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/sessions/resolve-session.test.ts`
Expected: FAIL — cannot find module `./resolve-session`.

- [ ] **Step 3: Write minimal implementation**

Create `src/sessions/resolve-session.ts`:

```ts
import type { IdentityProvenance } from "./identity";

export type Handle =
  | { by: "sessionId"; sessionId: string }
  | { by: "pid"; pid: number }
  | { by: "cwd"; cwd: string }
  | { by: "topicId"; topicId: number }
  | { by: "launchId"; launchId: string };

export interface SessionRecord {
  launchId: string | null; // P1: always null; populated in P2
  sessionId: string | null;
  claudePid: number;
  cwd: string;
  relayPort: number | null;
  relayPid: number | null;
  topicId: number | null;
  tmuxPane: string | null;
  tmuxSocket: string | null;
  cmuxWorkspaceId: string | null;
  provenance: IdentityProvenance;
}

export type Resolution =
  | { status: "resolved"; record: SessionRecord }
  | { status: "pending" }
  | { status: "miss" };

export function makeRecord(
  r: Omit<SessionRecord, "launchId"> & { launchId?: string | null },
): SessionRecord {
  const { launchId, ...rest } = r;
  return { ...rest, launchId: launchId ?? null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/sessions/resolve-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/resolve-session.ts src/sessions/resolve-session.test.ts
git commit -m "feat(identity-p1): resolveSession core types (Handle/SessionRecord/Resolution)"
```

---

### Task 2: Snapshot + `resolveSession` facade (delegates to current logic)

**Files:**

- Modify: `src/sessions/resolve-session.ts`
- Test: `src/sessions/resolve-session.test.ts`

**Interfaces:**

- Consumes: `resolveIdentities` (`src/sessions/identity.ts`), `PortFileData`, `TopicMapping`.
- Produces:
  - `interface ResolveSnapshot { aliveRelays: PortFileData[]; topics: TopicMapping[]; }`
  - `resolveSession(handle: Handle, snap: ResolveSnapshot): Resolution` — builds `SessionRecord`s from `resolveIdentities(snap)` enriched with the port-file target fields (pane/socket/cmux/port), then selects by handle using the SAME match ladder each domain uses today. Ambiguous (id-less sibling) → `miss` for positive-identity handles; a handle that matches a relay lacking a sessionId but is the sole relay in its cwd → `resolved` with `sessionId:null` (mirrors `provenance:'missing'` which today still routes by pid/cwd).

- [ ] **Step 1: Write the failing test**

Append to `src/sessions/resolve-session.test.ts`:

```ts
import { resolveSession, type ResolveSnapshot } from "./resolve-session";

function snap(relays: any[], topics: any[] = []): ResolveSnapshot {
  return { aliveRelays: relays, topics };
}
const relay = (o: any) => ({
  port: 1,
  pid: 10,
  ppid: 100,
  cwd: "/a",
  startedAt: "t",
  ...o,
});

test("by sessionId → resolved authoritative", () => {
  const s = snap(
    [relay({ sessionId: "sX", tmuxPane: "%3", tmuxSocket: "claude" })],
    [{ topicId: 7, sessionId: "sX", sessionName: "a", sessionDir: "/a" }],
  );
  const r = resolveSession({ by: "sessionId", sessionId: "sX" }, s);
  expect(r.status).toBe("resolved");
  if (r.status === "resolved") {
    expect(r.record.topicId).toBe(7);
    expect(r.record.tmuxPane).toBe("%3");
    expect(r.record.provenance).toBe("authoritative");
  }
});

test("by sessionId, no such session → miss", () => {
  const r = resolveSession(
    { by: "sessionId", sessionId: "nope" },
    snap([relay({ sessionId: "sX" })]),
  );
  expect(r.status).toBe("miss");
});

test("by cwd with 2 id-less siblings → miss (never guess across siblings)", () => {
  const s = snap([
    relay({ pid: 10, sessionId: undefined }),
    relay({ pid: 11, sessionId: undefined }),
  ]);
  const r = resolveSession({ by: "cwd", cwd: "/a" }, s);
  expect(r.status).toBe("miss");
});

test("by cwd, lone id-less relay → resolved with sessionId null (routes by pid today)", () => {
  const r = resolveSession(
    { by: "cwd", cwd: "/a" },
    snap([relay({ pid: 10, sessionId: undefined })]),
  );
  expect(r.status).toBe("resolved");
  if (r.status === "resolved") expect(r.record.sessionId).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/sessions/resolve-session.test.ts`
Expected: FAIL — `resolveSession` / `ResolveSnapshot` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/sessions/resolve-session.ts`:

```ts
import type { PortFileData } from "../relay/discovery";
import type { TopicMapping } from "../topics/topic-store";
import { resolveIdentities } from "./identity";

export interface ResolveSnapshot {
  aliveRelays: PortFileData[];
  topics: TopicMapping[];
}

/** Build the canonical record set from today's resolver + port-file target fields. */
function buildRecords(snap: ResolveSnapshot): SessionRecord[] {
  const byRelayPid = new Map<number, PortFileData>();
  for (const pf of snap.aliveRelays) byRelayPid.set(pf.pid, pf);
  return resolveIdentities({
    aliveRelays: snap.aliveRelays,
    topics: snap.topics,
  }).map((ri) => {
    const pf = byRelayPid.get(ri.relayPid);
    return makeRecord({
      sessionId: ri.sessionId,
      claudePid: ri.claudePid,
      cwd: ri.cwd,
      relayPort: pf?.port ?? null,
      relayPid: ri.relayPid,
      topicId: ri.topicId,
      tmuxPane: pf?.tmuxPane ?? null,
      tmuxSocket: pf?.tmuxSocket ?? null,
      cmuxWorkspaceId: pf?.cmuxWorkspaceId ?? null,
      provenance: ri.provenance,
    });
  });
}

export function resolveSession(
  handle: Handle,
  snap: ResolveSnapshot,
): Resolution {
  const records = buildRecords(snap);
  const pick = (pred: (r: SessionRecord) => boolean): Resolution => {
    const hits = records.filter(pred);
    if (hits.length === 1) return { status: "resolved", record: hits[0]! };
    if (hits.length === 0) return { status: "miss" };
    // >1 match on a positive-identity handle = ambiguous siblings → never guess.
    return { status: "miss" };
  };
  switch (handle.by) {
    case "sessionId":
      return pick((r) => r.sessionId === handle.sessionId);
    case "pid":
      return pick((r) => r.claudePid === handle.pid);
    case "topicId":
      return pick((r) => r.topicId === handle.topicId);
    case "cwd": {
      const inCwd = records.filter((r) => r.cwd === handle.cwd);
      if (inCwd.length === 1) return { status: "resolved", record: inCwd[0]! };
      return { status: "miss" }; // 0 or ambiguous siblings
    }
    case "launchId":
      return { status: "miss" }; // P1: launchId never populated
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/sessions/resolve-session.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sessions/resolve-session.ts src/sessions/resolve-session.test.ts
git commit -m "feat(identity-p1): resolveSession facade over resolveIdentities (behavior-preserving)"
```

---

### Task 3: Shadow comparator — `shadowResolveSession`

**Files:**

- Modify: `src/sessions/identity-shadow.ts`
- Test: `src/sessions/identity-shadow.test.ts` (create if absent)

**Interfaces:**

- Consumes: `resolveSession`, `Resolution`, `Handle`, `ResolveSnapshot`.
- Produces: `shadowResolveSession(site: string, currentAnswer: string | number | null, handle: Handle, snap: ResolveSnapshot): void` — computes `resolveSession(handle, snap)`, reduces it to the same shape the site returns (an id / topicId / port / null), and if it differs from `currentAnswer` calls the existing divergence logger with `{site, handle, current, shadow, reason}`. Observe-only; never throws into the caller.

- [ ] **Step 1: Write the failing test**

Create/append `src/sessions/identity-shadow.test.ts`:

```ts
import { test, expect, mock } from "bun:test";
import { shadowResolveSession, __setShadowLogger } from "./identity-shadow";

test("logs a divergence when resolveSession disagrees with current answer", () => {
  const logged: any[] = [];
  __setShadowLogger((e) => logged.push(e));
  const relay = {
    port: 1,
    pid: 10,
    ppid: 100,
    cwd: "/a",
    startedAt: "t",
    sessionId: "sX",
  };
  // current answer says "sOLD" but resolveSession(byPid 100) → "sX"
  shadowResolveSession(
    "selectRelayTarget",
    "sOLD",
    { by: "pid", pid: 100 },
    { aliveRelays: [relay as any], topics: [] },
  );
  expect(logged.length).toBe(1);
  expect(logged[0].site).toBe("selectRelayTarget");
  expect(logged[0].current).toBe("sOLD");
  expect(logged[0].shadow).toBe("sX");
});

test("no log when they agree", () => {
  const logged: any[] = [];
  __setShadowLogger((e) => logged.push(e));
  const relay = {
    port: 1,
    pid: 10,
    ppid: 100,
    cwd: "/a",
    startedAt: "t",
    sessionId: "sX",
  };
  shadowResolveSession(
    "selectRelayTarget",
    "sX",
    { by: "pid", pid: 100 },
    { aliveRelays: [relay as any], topics: [] },
  );
  expect(logged.length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/sessions/identity-shadow.test.ts`
Expected: FAIL — `shadowResolveSession` / `__setShadowLogger` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/sessions/identity-shadow.ts`:

```ts
import {
  resolveSession,
  type Handle,
  type ResolveSnapshot,
} from "./resolve-session";
import { info } from "../logger";

type ShadowEvent = {
  site: string;
  handle: Handle;
  current: unknown;
  shadow: unknown;
  reason: string;
};
let _shadowLog: (e: ShadowEvent) => void = (e) =>
  info("identity-shadow: resolveSession divergence", {
    site: e.site,
    current: String(e.current),
    shadow: String(e.shadow),
    reason: e.reason,
  });
/** Test seam. */
export function __setShadowLogger(fn: (e: ShadowEvent) => void): void {
  _shadowLog = fn;
}

/** Reduce a Resolution to the scalar the call site returns (id/topic/port/null). */
function scalar(
  r: ReturnType<typeof resolveSession>,
  want: "sessionId" | "topicId" | "relayPort",
): unknown {
  if (r.status !== "resolved") return r.status === "pending" ? undefined : null;
  return r.record[want];
}

export function shadowResolveSession(
  site: string,
  currentAnswer: string | number | null,
  handle: Handle,
  snap: ResolveSnapshot,
  want: "sessionId" | "topicId" | "relayPort" = "sessionId",
): void {
  try {
    const shadow = scalar(resolveSession(handle, snap), want);
    // `undefined` (pending) is not a divergence vs a transient current-null.
    if (shadow === undefined) return;
    if (shadow !== currentAnswer) {
      _shadowLog({
        site,
        handle,
        current: currentAnswer,
        shadow,
        reason: "mismatch",
      });
    }
  } catch {
    /* observe-only: never disturb the live path */
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/sessions/identity-shadow.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/identity-shadow.ts src/sessions/identity-shadow.test.ts
git commit -m "feat(identity-p1): shadowResolveSession divergence logger (observe-only)"
```

---

### Task 4: Wire the snapshot into the watcher refresh

**Files:**

- Modify: `src/sessions/watcher.ts` (in `doRefresh`, near where `resolveIdentities`/port files are already gathered)
- Modify: `src/sessions/resolve-session.ts` (add a module-level current-snapshot holder)
- Test: `src/sessions/resolve-session.test.ts`

**Interfaces:**

- Produces: `setCurrentSnapshot(snap: ResolveSnapshot): void` and `getCurrentSnapshot(): ResolveSnapshot` — the watcher writes the live snapshot each refresh so call sites (which run outside the refresh) can shadow/resolve against a consistent recent view.

- [ ] **Step 1: Write the failing test**

Append to `src/sessions/resolve-session.test.ts`:

```ts
import { setCurrentSnapshot, getCurrentSnapshot } from "./resolve-session";
test("current snapshot round-trips", () => {
  const s = { aliveRelays: [], topics: [] };
  setCurrentSnapshot(s);
  expect(getCurrentSnapshot()).toBe(s);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/sessions/resolve-session.test.ts`
Expected: FAIL — `setCurrentSnapshot`/`getCurrentSnapshot` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/sessions/resolve-session.ts`:

```ts
let _current: ResolveSnapshot = { aliveRelays: [], topics: [] };
export function setCurrentSnapshot(snap: ResolveSnapshot): void {
  _current = snap;
}
export function getCurrentSnapshot(): ResolveSnapshot {
  return _current;
}
```

Then in `src/sessions/watcher.ts` `doRefresh`, after the alive relays + topics are gathered for `resolveIdentities` (search for the existing `resolveIdentities(` call), add:

```ts
setCurrentSnapshot({ aliveRelays, topics });
```

(Use the exact variable names already in scope at that point; import `setCurrentSnapshot` from `./resolve-session`.)

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test src/sessions/resolve-session.test.ts && bun run typecheck`
Expected: PASS + no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/resolve-session.ts src/sessions/watcher.ts
git commit -m "feat(identity-p1): publish live resolve snapshot from watcher refresh"
```

---

### Task 5: Shadow-instrument `selectRelayTarget` (first site, NO migration)

**Files:**

- Modify: `src/relay/discovery.ts` (`selectRelayTarget`, ~:393)
- Test: `src/relay/discovery.test.ts` (append)

**Interfaces:**

- Consumes: `shadowResolveSession`, `getCurrentSnapshot`.
- Produces: no interface change — `selectRelayTarget` returns exactly as before; it additionally calls `shadowResolveSession("selectRelayTarget", <the id it chose or null>, <handle built from its selector>, getCurrentSnapshot())` right before `return`.

- [ ] **Step 1: Write the failing test**

Append to `src/relay/discovery.test.ts`:

```ts
import { test, expect } from "bun:test";
import { __setShadowLogger } from "../sessions/identity-shadow";
import { setCurrentSnapshot } from "../sessions/resolve-session";
import { selectRelayTarget } from "./discovery";

test("selectRelayTarget still returns current answer AND shadows it", () => {
  const logged: any[] = [];
  __setShadowLogger((e) => logged.push(e));
  const pf = {
    port: 1,
    pid: 10,
    ppid: 100,
    cwd: "/a",
    startedAt: "t",
    sessionId: "sX",
  } as any;
  setCurrentSnapshot({ aliveRelays: [pf], topics: [] });
  const chosen = selectRelayTarget([pf], { sessionId: "sX" });
  expect(chosen?.sessionId).toBe("sX"); // behavior unchanged
  expect(logged.length).toBe(0); // agrees → no divergence
});
```

(Adjust the `selectRelayTarget` call to its real signature if it differs; the assertion that matters is: same return + shadow called.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/relay/discovery.test.ts`
Expected: FAIL — no shadow call yet (logger asserted, but more importantly Step 3 hasn't added the shadow line; if the test passes trivially, strengthen it by asserting a divergence case is logged when the port file id differs from the selector).

- [ ] **Step 3: Add the shadow call (no behavior change)**

In `selectRelayTarget`, immediately before each `return` of a chosen target (or once at a single exit if refactored), compute the handle from the selector and shadow it:

```ts
import { shadowResolveSession } from "../sessions/identity-shadow";
import { getCurrentSnapshot, type Handle } from "../sessions/resolve-session";
// ...
const handle: Handle = selector?.sessionId
  ? { by: "sessionId", sessionId: selector.sessionId }
  : selector?.claudePid
    ? { by: "pid", pid: selector.claudePid }
    : { by: "cwd", cwd: selector?.sessionDir ?? "" };
shadowResolveSession(
  "selectRelayTarget",
  chosen?.sessionId ?? null,
  handle,
  getCurrentSnapshot(),
);
return chosen;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/relay/discovery.test.ts`
Expected: PASS — same return value; shadow invoked.

- [ ] **Step 5: Commit**

```bash
git add src/relay/discovery.ts src/relay/discovery.test.ts
git commit -m "feat(identity-p1): shadow selectRelayTarget against resolveSession (observe-only)"
```

- [ ] **Step 6: SOAK GATE (manual)**

Restart the bot (`./restart.sh`), use both a normal and a `/clear`'d session in the same folder, and confirm ZERO `identity-shadow: resolveSession divergence site=selectRelayTarget` lines over the soak window in `~/Library/Logs/claude-mobile-bridge/bot.log`. Only proceed to Task 6 when clean. If divergences appear, they are the audit's predicted policy gaps — fix `resolveSession`'s policy (not the site) and re-soak.

---

### Task 6: Migrate `selectRelayTarget` to `resolveSession`

**Files:**

- Modify: `src/relay/discovery.ts`
- Test: `src/relay/discovery.test.ts`

**Interfaces:**

- Consumes: `resolveSession`, `getCurrentSnapshot`.
- Produces: `selectRelayTarget` internals now derive the chosen relay from `resolveSession(handle, snap)` → `record.relayPort`/`relayPid`, keeping the SAME return type. The `alive[0]` empty-selector branch is PRESERVED (P1 deletes nothing) — only the id/pid/cwd branches route through `resolveSession`.

- [ ] **Step 1: Write the failing test**

Append a test asserting the migrated path returns the record-derived target and that ambiguous siblings still refuse (return null), matching pre-migration behavior:

```ts
test("migrated selectRelayTarget refuses ambiguous siblings (unchanged)", () => {
  const a = { port: 1, pid: 10, ppid: 100, cwd: "/a", startedAt: "t" } as any;
  const b = { port: 2, pid: 11, ppid: 101, cwd: "/a", startedAt: "t" } as any;
  setCurrentSnapshot({ aliveRelays: [a, b], topics: [] });
  expect(selectRelayTarget([a, b], { sessionDir: "/a" })).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/relay/discovery.test.ts`
Expected: FAIL if the current cwd branch would have guessed; PASS-after-implement confirms parity.

- [ ] **Step 3: Implement the migration**

Replace the id/pid/cwd match ladder body with a `resolveSession` lookup that returns `record.relayPid`→the matching `PortFileData`; keep the empty-selector `alive[0]` and the fail-closed `null` exactly as before.

- [ ] **Step 4: Run tests + typecheck + full suite**

Run: `bun test src/relay/ && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/relay/discovery.ts src/relay/discovery.test.ts
git commit -m "refactor(identity-p1): route selectRelayTarget id/pid/cwd through resolveSession"
```

---

### Tasks 7–N: Shadow-then-migrate the remaining live sites (same recipe)

Each remaining site follows the **exact 6-step recipe from Tasks 5+6**: (1) append a shadow call with the site's handle and current answer; (2) commit observe-only; (3) SOAK to zero divergence; (4) write a parity test incl. the site's fallback policy; (5) migrate internals to `resolveSession` preserving that policy; (6) commit. Do them ONE site per task, in this order. `want` selects which record field the shadow compares.

| Task | Site (file:fn)                                                                                        | Handle built from                                                                                                  | `want`      | Fallback policy to PRESERVE                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 7    | `topics/topic-store.ts` `getTopicBySession(name)` + `topic-router.ts` `getThreadId(name)`             | in P1, name→record via the watcher registry's name→id map, then `{by:'sessionId'}`; log if name maps to >1 live id | `topicId`   | name non-uniqueness → if 2 live sessions share the base name, MISS (today returns first — a divergence to surface, NOT copy)      |
| 8    | `handlers/commands/terminal-inject.ts` `resolveTmuxTarget`                                            | `{by:'sessionId'}` then `{by:'pid'}`                                                                               | `sessionId` | positive-identity: no pane on matched record → refuse (miss), never cwd fall-through                                              |
| 9    | `handlers/commands/terminal-inject.ts` `resolveCmuxWorkspace`                                         | `{by:'sessionId'}` then `{by:'pid'}`                                                                               | `sessionId` | same positive-identity refusal; spawn-registry-by-cwd stays as a P1 fallback (not migrated)                                       |
| 10   | `handlers/watch/jsonl-tailer.ts` `_resolveDriftTargetId` (shared-dir branch only)                     | `{by:'pid'}`                                                                                                       | `sessionId` | sole-owner newest-in-dir branch NOT migrated in P1 (needs the P2 hook id); only the pid/port branch routes through resolveSession |
| 11   | `web/routes/auq-bridge.ts` `getTopicBySessionId` + `sessions/context.ts` follow-up `getSession(name)` | `{by:'sessionId'}`                                                                                                 | `topicId`   | dir-fallback keeps its `crossesSession` guard (not migrated)                                                                      |

Sites explicitly NOT in P1 (accessor-only or exempt), documented for completeness:

- `getSessionByTopic(topicId)` — already topicId-keyed; becomes `resolveSession({by:'topicId'})` accessor with identical result, no policy. Optional trivial migration.
- `findSessionJsonlPath(id)` — already a pure id lookup; becomes `jsonlPathFor(record)`. No behavior change.
- **EXEMPT:** `offline.ts`, `history.ts` dir-fallbacks, Ghostty/Cursor inject (blocked cases). Do NOT migrate.

- [ ] **Step (per task): follow the Task 5+6 recipe for the row, one commit for shadow, one for migrate, soak gate between.** Each row's parity test MUST encode the "Fallback policy to PRESERVE" column as an explicit assertion.

---

### Task N+1: Regression harness — the invariant gate

**Files:**

- Modify: `src/sessions/identity-invariants.ts` (or its test) to add a `resolveSession`-consistency invariant.
- Test: `src/sessions/identity-invariants.test.ts`

**Interfaces:**

- Produces: an invariant `I_resolveSession`: for every live authoritative session, `resolveSession({by:'sessionId', sessionId})` resolves to a record whose `topicId`/`claudePid` match the watcher registry. Surfaces as a WARN via the existing identity-report path (observe-only, same as WS-1).

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { checkResolveSessionInvariant } from "./identity-invariants";

test("flags a session whose resolveSession topicId disagrees with the registry", () => {
  const violations = checkResolveSessionInvariant({
    registry: [{ id: "sX", claudePid: 100, topicId: 7 }],
    snapshot: {
      aliveRelays: [
        {
          port: 1,
          pid: 10,
          ppid: 100,
          cwd: "/a",
          startedAt: "t",
          sessionId: "sX",
        } as any,
      ],
      topics: [
        { topicId: 9, sessionId: "sX", sessionName: "a", sessionDir: "/a" },
      ],
    },
  });
  expect(violations.map((v) => v.kind)).toContain(
    "resolveSession_topic_disagree",
  );
});
```

- [ ] **Step 2–4:** implement `checkResolveSessionInvariant`, run to green, wire into the existing `identity-report` emitter (observe-only).

- [ ] **Step 5: Commit**

```bash
git add src/sessions/identity-invariants.ts src/sessions/identity-invariants.test.ts src/sessions/identity-report.ts
git commit -m "feat(identity-p1): resolveSession-consistency invariant (observe-only gate)"
```

---

## Self-Review checklist (run before handing off)

1. **Spec coverage:** every LIVE identify site from the audit doc (`docs/superpowers/notes/2026-07-06-identity-find-identify-audit.md`) appears either in Tasks 5–11 or the explicit EXEMPT/accessor list. Offline/history exempt. ✅ intent.
2. **Behavior-preserving:** no task deletes a fallback; `alive[0]`, positive-identity refusal, `crossesSession`, newest-in-dir-sole-owner all preserved into P2. ✅
3. **Pending≠miss:** the three-state `Resolution` is used so spawn-race not-found stays retryable. ✅
4. **Type consistency:** `SessionRecord`, `Handle`, `Resolution`, `ResolveSnapshot`, `resolveSession`, `shadowResolveSession`, `getCurrentSnapshot` names are identical across all tasks. ✅
5. **No launchId use in P1:** field exists, always null, nothing keys on it. ✅

## Handoff note

P1 delivers: one resolver, every live site shadow-verified and migrated with zero divergence, an invariant gate — and NOTHING changed behaviorally. **P2** then makes ONE internal change to `resolveSession`/its snapshot source: the SessionStart hook mints+persists a stable id (keyed pid+starttime) and `resolveSession` prefers it for hook-bearing sessions, current logic for the rest. **P3** (soak-gated) pins `--session-id` for readable names and deletes the now-dead fallbacks. Reconcile all three against `docs/superpowers/specs/2026-06-26-session-identity-consolidation.md` (amend assumptions: hook-mints-own-id, hook-primary) rather than forking.
