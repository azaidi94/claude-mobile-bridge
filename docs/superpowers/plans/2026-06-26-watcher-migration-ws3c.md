# Watcher Migration (WS-3c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make `resolveIdentities` the single source of the watcher's per-relay sessionId decision, removing the duplicate `resolveSiblingId` rule — as a **behavior-preserving** consolidation (zero routing change), not a behavior change.

**Architecture:** Today the watcher resolves each relay's sessionId in a loop (`watcher.ts:463-485`) via `resolveSiblingId(pf.sessionId, pfs.length, fallback)`. That rule and `resolveIdentities` are the same three-way decision (authoritative / ambiguous / lone-fallback) — EXCEPT the ambiguity count: `resolveSiblingId` and WS-1's checker count **all** relays in a cwd (`pfs.length > 1`), while `resolveIdentities` currently counts only **id-less** relays. Task 1 aligns the resolver to the broad ("all relays") rule so all three agree; Task 2 then routes the watcher loop through the resolver. With the rules identical, the migration changes no behavior.

**Tech Stack:** TypeScript, Bun test runner.

**Risk note (user-accepted):** This is the first behavior-touching step. It is structured to be behavior-preserving, but it edits the hottest code (session routing). The user has explicitly accepted "revert or debug if it doesn't work." After merge, the bot must be restarted to run it; watch `identity-shadow:` / `identity:` logs for regressions.

## Global Constraints

- **Behavior-preserving:** after both tasks, the watcher must assign the same sessionIds it does today for every case the existing tests cover. The only intentional change is internal (one rule instead of two).
- Ambiguity rule (the single rule, post-Task-1): a relay is `ambiguous` when it has no sessionId AND its cwd holds **more than one live relay total** (id-bearing or not). This matches `resolveSiblingId(pf.sessionId, pfs.length, …)` and WS-1's `checkIdentityInvariants` (`relaysByCwd.get(cwd).length > 1`).
- `resolveIdentities` stays pure; the watcher passes that dir's port files as `aliveRelays` (they are already alive-filtered by `scanPortFiles`).
- Commit style: no "Generated with Claude Code" / Co-Authored-By trailers.

---

### Task 1: Align `resolveIdentities` ambiguity to the broad (all-relays) rule

**Files:**

- Modify: `src/sessions/identity.ts`
- Modify: `src/__tests__/identity-resolver.test.ts`

**Interfaces:** unchanged signature; only the `ambiguous` vs `missing` classification for an id-less relay changes (now broad).

- [ ] **Step 1: Update the crux test to the broad rule (RED)**

In `src/__tests__/identity-resolver.test.ts`, the existing test titled
"an id-less relay sharing a cwd with an authoritative one is still 'missing' …"
encodes the OLD narrow rule. Replace it with the broad-rule expectation:

```typescript
test("an id-less relay sharing a cwd with ANY other relay is 'ambiguous' (broad rule, coherent with WS-1 + the watcher)", () => {
  const out = resolveIdentities({
    aliveRelays: [
      relay({ pid: 1, ppid: 11, cwd: "/mix", sessionId: "sid-1" }),
      relay({ pid: 2, ppid: 22, cwd: "/mix", sessionId: undefined }),
    ],
    topics: [],
  });
  expect(out.find((r) => r.relayPid === 2)!.provenance).toBe("ambiguous");
});
```

The other resolver tests (lone id-less → `missing`; two id-less → `ambiguous`;
authoritative cases) remain unchanged and must stay green.

- [ ] **Step 2: Run tests, verify the changed test fails**

Run: `bun test src/__tests__/identity-resolver.test.ts`
Expected: FAIL on the new "ambiguous (broad rule)" test — current code returns `missing`.

- [ ] **Step 3: Implement the broad rule**

In `src/sessions/identity.ts`, replace the id-less-only count with a total-relay-per-cwd count:

```typescript
// Count ALL live relays per cwd (not just id-less ones). An id-less relay in a
// cwd that holds more than one relay is `ambiguous` — never guess across
// siblings. This matches resolveSiblingId (pfs.length > 1) and WS-1's checker.
const relaysByCwd = new Map<string, number>();
for (const r of aliveRelays) {
  relaysByCwd.set(r.cwd, (relaysByCwd.get(r.cwd) ?? 0) + 1);
}
```

Then in the classification:

```typescript
if (sessionId) provenance = "authoritative";
else if ((relaysByCwd.get(r.cwd) ?? 0) > 1) provenance = "ambiguous";
else provenance = "missing";
```

(Delete the old `idlessByCwd` map.)

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun test src/__tests__/identity-resolver.test.ts src/__tests__/identity-shadow.test.ts src/__tests__/identity-invariants.test.ts`
Expected: all PASS. (Shadow/invariant tests don't exercise the mixed case, so they stay green.)

- [ ] **Step 5: Commit**

```bash
git add src/sessions/identity.ts src/__tests__/identity-resolver.test.ts
git commit -m "refactor(identity): resolver ambiguity uses the broad all-relays rule

Aligns resolveIdentities with resolveSiblingId and WS-1's checker: an id-less
relay in a cwd holding >1 relay is 'ambiguous' (never guess across siblings),
not 'missing'. Makes the three rules coherent ahead of the watcher migration."
```

---

### Task 2: Route the watcher's id resolution through `resolveIdentities`

**Files:**

- Modify: `src/sessions/watcher.ts` (the `scanSessions` per-relay loop; remove `resolveSiblingId`)
- Modify/Delete: `src/__tests__/sibling-session-id.test.ts` (it unit-tests `resolveSiblingId`, which is being removed; its rule is now covered by `identity-resolver.test.ts`)

**Interfaces:** Consumes `resolveIdentities` (Task 1). No new exports.

- [ ] **Step 1: Confirm `resolveSiblingId` has exactly one production caller**

Run: `grep -rn "resolveSiblingId" src/ | grep -v "\.test\."`
Expected: only its definition in `watcher.ts` and the one call inside `scanSessions`. If there is any other caller, STOP and report — the migration assumes a single call site.

- [ ] **Step 2: Replace the loop's resolution with the resolver (behavior-preserving)**

In `src/sessions/watcher.ts`, replace the per-relay loop (currently `watcher.ts:463-485`, the block that calls `resolveSiblingId`) with:

```typescript
// Resolve each relay's id via the single shared rule. `unusedFallbacks`
// still supplies the lone-relay (`missing`) JSONL back-fill; `ambiguous`
// (a cwd with >1 relay) resolves empty so exact pid (ppid) routing wins.
const identities = resolveIdentities({ aliveRelays: pfs, topics: [] });
const identityByRelayPid = new Map(identities.map((i) => [i.relayPid, i]));
let fallbackIdx = 0;
for (const pf of pfs) {
  if (dirFound.length >= processCount) break;
  if (pf.sessionId && knownIds.has(pf.sessionId)) continue;
  const identity = identityByRelayPid.get(pf.pid);
  let resolvedId: string;
  if (identity?.provenance === "authoritative" && identity.sessionId) {
    resolvedId = identity.sessionId;
  } else if (identity?.provenance === "missing") {
    resolvedId = unusedFallbacks[fallbackIdx++] ?? "";
  } else {
    resolvedId = ""; // ambiguous (or unknown) — pid routes it
  }
  dirFound.push({
    id: resolvedId,
    name: "",
    dir,
    lastActivity:
      jsonlMtime.get(resolvedId) ??
      (pf.startedAt ? new Date(pf.startedAt).getTime() : Date.now()),
    source: "desktop",
    pid: pf.ppid,
  });
  if (resolvedId) knownIds.add(resolvedId);
}
```

Add the import at the top of `watcher.ts` (if not already present from earlier tasks):

```typescript
import { resolveIdentities } from "./identity";
```

- [ ] **Step 3: Remove the now-dead `resolveSiblingId` and its test**

Delete the `resolveSiblingId` function from `watcher.ts` (the exported function and its doc comment). Delete `src/__tests__/sibling-session-id.test.ts` (its rule is now covered by `identity-resolver.test.ts`'s ambiguity tests).

Run: `grep -rn "resolveSiblingId" src/`
Expected: no matches.

- [ ] **Step 4: Typecheck + run the routing-sensitive suites**

Run: `bun run typecheck`
Expected: clean.
Run: `bun test src/__tests__/identity-resolver.test.ts src/__tests__/identity-shadow.test.ts src/__tests__/session-manager.test.ts src/__tests__/watcher-coalesce.test.ts`
Expected: all PASS. These cover the watcher's session assembly + coalescing; green here means the migration preserved behavior.

- [ ] **Step 5: Run the full isolated suite**

Run: `bun run test:isolated`
Expected: no NEW failures vs the pre-task baseline. (The suite has known pre-existing test-ordering failures; compare counts, do not assume all-green.) If a routing/sibling test regresses, the migration changed behavior — STOP and report which test and the diff in expectation.

- [ ] **Step 6: Commit**

```bash
git add src/sessions/watcher.ts src/__tests__/sibling-session-id.test.ts
git commit -m "refactor(watcher): resolve relay sessionIds via resolveIdentities

The watcher's per-relay id loop now consumes the single resolveIdentities rule
instead of the duplicate resolveSiblingId (now removed). Behavior-preserving:
authoritative → pf.sessionId, ambiguous (>1 relay in cwd) → empty (pid routes),
lone missing → JSONL back-fill. One rule, one place — the core WS-3 consolidation."
```

---

## Post-merge (operator)

1. Restart the bot so it runs the migrated watcher (`bun run dev` / the launchd service).
2. Watch `bot.log` for `identity-shadow:` `registry_only`/`registry_resolver_disagree` lines and any `identity:` invariant warnings, especially after starting two sessions in one folder. Zero = the migration held. Any divergence = investigate or revert `WS-3c` (the two commits) — the prior behavior is one `git revert` away.

## Self-review notes

- Behavior-preservation rests on Task 1 making the resolver's ambiguity rule identical to the removed `resolveSiblingId` (broad, all-relays). This also resolves the WS-3a final-review coherence finding in the safe direction (resolver now matches WS-1).
- The lone-relay JSONL back-fill (`unusedFallbacks`) is preserved verbatim for the `missing` case — the one place the watcher still "guesses", and only when safe (single relay in the dir).
- No placeholders; every step carries real code and exact commands.
- WS-3a plan prose that called the resolver "deliberately narrower" than WS-1 is now stale — the controller updates it when this lands.
