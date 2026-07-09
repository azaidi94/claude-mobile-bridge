# Identity P3 — Migrate Consumers onto `launchUuid` + Topic Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every "which session is this" site off filesystem inference and onto the P2 registry's `launchUuid`, then flip the launcher and topic lifecycle so N `ccd` sessions in one folder each resolve to — and clean up — their own Telegram topic.

**Architecture:** P2 (merged separately) made the SessionStart hook mint a stable `launchUuid` per Claude process and publish `~/.claude-mobile-bridge/registry/<launchUuid>.json`, observed-only. P3 consumes it: **P3a** repoints the topic↔session lockstep, injection, and AUQ/cron/auto-watch sites onto `by:launchId`, each behind the shadow→soak→migrate gate (the P1 Task-6 / WS-3c pattern). **P3b** deletes the `byDir`/newest-in-dir/`-2` fallbacks and flips `scripts/tmux/launch.sh` to always-create, plus enables the topic lifecycle: create-on-start and **auto-delete-on-end**.

**Tech Stack:** Bun + TypeScript. Registry reader is `src/sessions/registry.ts` (from P2). Topic lifecycle lives in `src/topics/`. Launcher is bash (`scripts/tmux/launch.sh`).

## Global Constraints

- **Gated migration.** Each consumer site moves behind a shadow→soak→migrate gate — the shadow must show **zero divergence** over a soak before that site routes on `launchUuid`. Never migrate two sites in one commit without each having soaked.
- **Fail-loud is scoped.** Only hook-bearing sessions fail loud on a registry miss. Cursor Composer (`source:"cursor"`, keeps its `cursor-<slug>` id), offline/history discovery (stays filesystem-scan), and the pre-hook `pending` window keep their existing lookups. See spec §2.1.
- **Delete last.** The `byDir` / newest-in-dir / `-2` fallbacks are removed only in P3b, after every P3a site has soaked clean.
- **Topic deletion must never nuke a live session.** Auto-delete requires a confirmed-death signal (consecutive-tick absence) AND a bot-startup grace window — a restart or a single missed detection tick must not delete a live topic.
- **Registry record shape** (`RegistryRecord`, from P2): `{ launchUuid, claudePid, startTime, sessionId, cwd, source, updatedAt }`. `launchUuid` stable for process life; `sessionId` rolls on `/clear`.
- Test runner: `bun test`. Full pre-commit suite is occasionally flaky (unrelated SSE-timeout test) — retry once.
- Work happens on local `main` (push-protected; branch/PR to land).

---

## Status

**Scaffold.** This plan's task **index** (P3a §1–4, P3b §5–8) is fixed by the approved design spec (`docs/superpowers/specs/2026-07-07-identity-p2-p3-registry-design.md` §5–§6). Each P3a/P3b task marked _(expand at execution)_ gets its bite-sized TDD steps written immediately before it runs — the concrete shadow/migration code depends on what the **P2 soak** reveals, so detailing it now would be guesswork. **Task 6 (auto-delete-on-end) is fully detailed now**, per request, because its shape is already settled by the spec and the existing topic/liveness APIs.

**Do not start P3 until the P2 soak is clean** (registry mints observed + zero `launchUuid divergence` over a soak with ≥2 hook-minted sessions in one folder).

---

## File Structure

- **`src/sessions/registry.ts`** (from P2) — reader + indexes. P3a adds `findByLaunchUuid` / `launchUuidByClaudePid` consumers; no reshape.
- **`src/topics/topic-store.ts` / `topic-manager.ts` / `topic-router.ts`** — repoint the ~15 `sessionName`-keyed lookups to `launchUuid` (P3a Task 1). Backfill on-disk topic-store/ledger records with `launchUuid` (P3a Task 1).
- **`src/sessions/inject/*` (`resolveTmuxTarget`/`resolveCmuxWorkspace`)** — route pane/tty/workspace by `launchUuid` (P3a Task 2).
- **AUQ bridge / cron / auto-watch outbound** — id lookups by `launchUuid` (P3a Task 3).
- **`src/sessions/topic-reaper.ts`** (NEW, Task 6) — pure `planTopicDeletions(...)` + the IO wrapper that calls `topicManager.deleteTopic`. One responsibility: turn "registry pid is gone" into a debounced topic deletion.
- **`src/sessions/watcher.ts`** — Task 6 calls the reaper each refresh tick (it already computes `runningProcesses`).
- **`scripts/tmux/launch.sh`** — P3b Task 7: always-create, drop `--session-id` pin + reap.
- **Delete** `byDir`/newest-in-dir/`-2` — P3b Task 8.

---

## P3a — Migrate consumers (shadow-gated)

### Task 1: Topic ↔ session lockstep → `launchUuid`

Expanded from the scaffold into **1a additive → 1b shadow → (soak) → 1c flip**, honoring the plan's shadow→soak→migrate constraint. The 15-site read-flip (1c) is gated on a clean 1b soak with ≥2 same-folder siblings — the exact scenario the 2026-07-08 P2 soak reproduced a cross-wire in.

**Grounding facts (from the 2026-07-08 code map):**

- `TopicMapping` (`src/types.ts:116-123`): `{topicId, sessionName, sessionDir, sessionId?, isOnline, createdAt}` — no `launchUuid`. Store is a flat array in `~/.claude-mobile-bridge/topics.json`; every lookup is a linear `.find` (`src/topics/topic-store.ts`).
- Primary lookup `getTopicBySession(name)` (`topic-store.ts:132`) has ~15 callers (enumerated in the audit + code map). `getTopicBySessionId(sessionId)` (`:153`) is already sibling-safe.
- `resolveSession({by:"launchId", launchId}, snap)` resolves to a `SessionRecord` whose `topicId` is populated from the store via `resolveIdentities`; `snap.launchUuidByPid` is set every refresh (`watcher.ts:304`). `SessionRecord.launchUuid` already exists (P2).
- Shadow pattern to copy: `shadowLaunchUuid` (`identity-shadow.ts:98`), called from `watcher.ts:312`; the `scalar(res, "topicId")` helper (`:90`) already supports topicId comparison.
- **R1 carve-out:** Cursor (`source:"cursor"`, `cursor-<slug>`), bare `claude`, offline/history sessions have NO `launchUuid`. The flip MUST fall back to the name lookup for them — fail-loud is scoped to hook-bearing sessions only.
- **Out of scope for Task 1:** event-bus channel keys stay `sessionName` (they're pub/sub keys, stable per session, not topic-identity lookups); the `-2` name-generation itself stays until P3b Task 8. Task 1 changes only _which key resolves a topic_, not how names are made.

---

#### Task 1a: Add `launchUuid` to `TopicMapping` + thread through creation + backfill (ADDITIVE, observe-only)

**Files:**

- Modify: `src/types.ts` (add field to `TopicMapping`)
- Modify: `src/topics/topic-store.ts` (add `getTopicByLaunchUuid`; guard `updateTopicMapping` so a falsy `launchUuid` can't clobber a stored one — mirror the existing `sessionId` guard at `:175`)
- Modify: `src/topics/topic-manager.ts` (`_createTopicImpl` stores `launchUuid` when resolvable at creation)
- Create: `src/sessions/topic-launchuuid-backfill.ts` (pure `topicLaunchUuidBackfillPlan`)
- Modify: `src/sessions/watcher.ts` (apply the backfill plan each refresh, mirroring the `sessionId`-refresh write at `:727`)
- Test: `src/__tests__/topic-launchuuid-backfill.test.ts`, plus assertions appended to `topic-store` / `topic-manager` tests

**Interfaces:**

- Produces:
  - `TopicMapping.launchUuid?: string` (optional — absent on Cursor/bare/offline records, and on all pre-migration records until backfilled).
  - `getTopicByLaunchUuid(launchUuid: string): TopicMapping | undefined` — `.find(t => t.launchUuid === launchUuid)`, returns `undefined` for a falsy arg (mirror `getTopicBySessionId`'s empty-string guard at `:153`).
  - `topicLaunchUuidBackfillPlan(topics: TopicMapping[], launchUuidBySessionId: Map<string,string>): { sessionName: string; launchUuid: string }[]` — **pure**. For each topic with a truthy `sessionId`, no existing `launchUuid`, and a hit in the map, emit one write. Skips topics already carrying a `launchUuid`, topics with no `sessionId`, and misses. (Keyed on `sessionId` because the existing `sessionId`-refresh keeps `topic.sessionId` anchored to the live rolling id, which equals the registry's `sessionId` field — so the map aligns; and once written, `launchUuid` is stable and becomes the durable key.)

- [ ] **Step 1: Failing test — `getTopicByLaunchUuid` + field**

Append to `src/__tests__/topic-store.test.ts` (match the file's existing setup/reset helpers):

```ts
test("getTopicByLaunchUuid finds by launchUuid and ignores falsy", () => {
  clearTopicStore();
  setChatId(-100);
  addTopicMapping({
    topicId: 5,
    sessionName: "kx",
    sessionDir: "/k",
    sessionId: "s1",
    isOnline: true,
    createdAt: "t",
    launchUuid: "u1",
  });
  expect(getTopicByLaunchUuid("u1")?.topicId).toBe(5);
  expect(getTopicByLaunchUuid("")).toBeUndefined();
  expect(getTopicByLaunchUuid("nope")).toBeUndefined();
});
```

- [ ] **Step 2: Run → FAIL** (`getTopicByLaunchUuid` not exported; `launchUuid` not on the type).
      Run: `bun test src/__tests__/topic-store.test.ts`

- [ ] **Step 3: Add the field + accessor**
      Add `launchUuid?: string;` to `TopicMapping` (`src/types.ts`). Add to `topic-store.ts`:

```ts
export function getTopicByLaunchUuid(
  launchUuid: string,
): TopicMapping | undefined {
  if (!launchUuid) return undefined;
  return getTopicStore().topics.find((t) => t.launchUuid === launchUuid);
}
```

Extend the `updateTopicMapping` clobber-guard so a falsy incoming `launchUuid` does not overwrite a stored one (mirror the `sessionId` guard already at `:175`).

- [ ] **Step 4: Run → PASS**
      Run: `bun test src/__tests__/topic-store.test.ts`

- [ ] **Step 5: Failing test — backfill plan**

Create `src/__tests__/topic-launchuuid-backfill.test.ts`:

```ts
import { topicLaunchUuidBackfillPlan } from "../sessions/topic-launchuuid-backfill";
import type { TopicMapping } from "../types";

const tm = (o: Partial<TopicMapping>): TopicMapping => ({
  topicId: 1,
  sessionName: "n",
  sessionDir: "/d",
  isOnline: true,
  createdAt: "t",
  ...o,
});

test("plans a write only for id-bearing topics missing launchUuid with a map hit", () => {
  const topics = [
    tm({ sessionName: "a", sessionId: "s1" }), // → write u1
    tm({ sessionName: "b", sessionId: "s2", launchUuid: "u2" }), // already set → skip
    tm({ sessionName: "c" }), // no sessionId → skip
    tm({ sessionName: "d", sessionId: "s9" }), // no map hit → skip
  ];
  const map = new Map([
    ["s1", "u1"],
    ["s2", "u2"],
  ]);
  expect(topicLaunchUuidBackfillPlan(topics, map)).toEqual([
    { sessionName: "a", launchUuid: "u1" },
  ]);
});
```

- [ ] **Step 6: Run → FAIL** (module missing).
      Run: `bun test src/__tests__/topic-launchuuid-backfill.test.ts`

- [ ] **Step 7: Implement the pure plan**

```ts
import type { TopicMapping } from "../types";
export function topicLaunchUuidBackfillPlan(
  topics: TopicMapping[],
  launchUuidBySessionId: Map<string, string>,
): { sessionName: string; launchUuid: string }[] {
  const out: { sessionName: string; launchUuid: string }[] = [];
  for (const t of topics) {
    if (t.launchUuid || !t.sessionId) continue;
    const uuid = launchUuidBySessionId.get(t.sessionId);
    if (uuid) out.push({ sessionName: t.sessionName, launchUuid: uuid });
  }
  return out;
}
```

- [ ] **Step 8: Run → PASS**
      Run: `bun test src/__tests__/topic-launchuuid-backfill.test.ts`

- [ ] **Step 9: Store `launchUuid` at creation + apply backfill in the watcher**
- In `_createTopicImpl` (`topic-manager.ts`): when a `launchUuid` is resolvable for the session being created (resolve via `resolveSession({by:"sessionId"|"pid"}, getCurrentSnapshot()).record?.launchUuid`, guarded for miss), include it in the `addTopicMapping({...})` call. Absent → omit (Cursor/bare stay unkeyed).
- In `watcher.ts` `doRefresh`/`scanSessions`, after the snapshot is set: build `launchUuidBySessionId` from `readRegistry()` (latest per `sessionId`, same tie-break as `launchUuidByClaudePid`), run `topicLaunchUuidBackfillPlan(getTopicStore().topics, map)`, and for each entry call `updateTopicMapping(sessionName, { launchUuid })`. Wrap in try/catch; observe-only (writing a field nothing reads yet).

- [ ] **Step 10: Run the touched suites → PASS**
      Run: `bun test src/__tests__/topic-store.test.ts src/__tests__/topic-launchuuid-backfill.test.ts src/__tests__/topic-manager.test.ts src/__tests__/watch.test.ts`

- [ ] **Step 11: Commit**

```bash
git add src/types.ts src/topics/topic-store.ts src/topics/topic-manager.ts src/sessions/topic-launchuuid-backfill.ts src/sessions/watcher.ts src/__tests__/topic-store.test.ts src/__tests__/topic-launchuuid-backfill.test.ts
git commit -m "feat(identity-p3a): add launchUuid to TopicMapping + creation-time set + backfill (additive)"
```

#### Task 1b: launchUuid topic-lookup divergence shadow (observe-only)

**Files:** Modify `src/sessions/identity-shadow.ts` (+ `watcher.ts` call site), test.

Add `shadowTopicByLaunchUuid(snap)` modeled on `shadowLaunchUuid`: for each `[pid, uuid]` in `snap.launchUuidByPid`, resolve the session by pid to its `sessionName`, compare **today's** `getTopicBySession(sessionName)?.topicId` against **launchUuid's** `getTopicByLaunchUuid(uuid)?.topicId`. Treat a `launchUuid`-side `undefined` (not yet backfilled) as **pending, not divergence** (mirror `scalar`'s undefined handling). Log `info("identity-shadow: topic launchUuid divergence", {pid, uuid, byName, byLaunch})` on a real mismatch. Call it from `watcher.ts` right after `shadowLaunchUuid(...)`. Observe-only.

**This is the migration's safety signal:** a divergence means keying the topic on `launchUuid` would return a different topic than the name does — exactly what must be zero (with siblings present) before 1c flips the reads.

#### Task 1b→1c SOAK GATE _(manual — like the P2 gate)_

Restart bot; run ≥2 same-folder siblings (`CLAUDE_CODE_TMUX_FRESH=1 ccd`); `/clear` one. Confirm `topics.json` records gain `launchUuid` (the backfill ran).

**Read the shadow differently from P2's.** This shadow compares `byToday` (name/sessionId `resolveIdentities` path — flip-prone) against `byLaunch` (stable `launchUuid`). So:

- **Steady state (siblings, no churn) MUST show 0 `topic launchUuid divergence`** — that proves 1c's read-flip is a no-op in the normal case (safe to flip).
- **A divergence UNDER `/clear` churn is EXPECTED-GOOD** _iff_ `byLaunch` is the correct topic. That's the shadow catching the exact cross-wire the 2026-07-08 P2 soak reproduced (`byToday` drifts to the orphan, `byLaunch` stays put) — i.e. 1c would _fix_ it. Inspect each churn-divergence: confirm `byLaunch` = the topic that session should own.

**Gate for 1c:** 0 divergence in steady state, AND every churn-divergence has `byLaunch` = the correct answer (1c is a fix, never a regression). A steady-state divergence, or a churn-divergence where `byLaunch` is wrong, blocks 1c and needs root-causing first.

#### Task 1c: Flip resolution to `launchUuid` (gated on 1b soak — PASSED 2026-07-08 run #2)

The soak passed AND proved the primary cross-wire vector is **`topic-id-refresh.ts`** (the name-based `sessionId` refresh stamped a sibling's orphaned id onto the wrong topic). So 1c is split by cohesive, independently-reviewable group — each safe incrementally because name and launchUuid **agree in steady state** (soak: 0 divergence at rest), so a partially-migrated system never cross-wires at rest; only the not-yet-migrated sites stay churn-vulnerable. The old name path stays as fallback (deleted in P3b, not here).

**Migration recipe (all sub-tasks):** a hook-bearing session's `launchUuid` is resolved from whatever identity a site holds — `pid` → `launchUuidByClaudePid(readRegistry()).get(pid)`, or `sessionId`/`topicId`/`pid` → `resolveSession(handle, getCurrentSnapshot()).record?.launchUuid`. R1 carve-out: when no `launchUuid` resolves (Cursor `source:"cursor"`, bare `claude`, offline), fall back to the existing name lookup — never fail loud there.

##### Task 1c-a: `topic-id-refresh.ts` matches by `launchUuid` (the proven cross-wire fix)

**Files:** Modify `src/sessions/topic-id-refresh.ts` (+ its test `src/__tests__/topic-id-refresh.test.ts`), wire enriched views at `src/sessions/watcher.ts:729`.

- Add `launchUuid?: string` to `PortFileIdView` and `TopicIdView`.
- Change the match: build `nameByLaunchUuid` from topics carrying a `launchUuid`. For each port file, resolve its target `sessionName` by **launchUuid first** (`pf.launchUuid && nameByLaunchUuid.has(...)`), falling back to `topicName` only when the port file has no resolvable launchUuid (R1). Keep the existing ambiguity guard (`ids.size !== 1 → skip`) and the emit shape `{sessionName, sessionId}` unchanged — the WRITE (`updateTopicMapping` by name at `watcher.ts:731`) is untouched; only the MATCH becomes launchUuid-keyed.
- At `watcher.ts:729`, map `portFiles` to views enriched with `launchUuid: launchUuidByClaudePid(readRegistry()).get(pf.pid)` (or reuse `launchUuidByPid` if in scope), and pass `getTopicStore().topics` (already carry `launchUuid` from 1a).
- **Why it fixes it:** B's port file carries B's `launchUuid` → matches B's topic regardless of a churn-mislabeled `topicName`, so A's topic can only be updated by A's own port file. Verifiable: re-run the `/clear` soak — the `resolveSession_topic_disagree` cross-wire must NOT appear.

Tests: launchUuid match overrides a wrong topicName; ambiguity still skipped; entries without launchUuid still match by topicName (R1); no-op when unchanged.

##### Task 1c-b: `topicForSession` helper + migrate routing-critical read sites _(expand after 1c-a)_

Introduce `topicForSession({launchUuid?, sessionName})` (in `topic-store.ts` or a thin `topic-resolve.ts`): `launchUuid` present → `getTopicByLaunchUuid(launchUuid)`; on a **hook-bearing** miss log a scoped warning and return undefined (do NOT silently name-fall-through); no launchUuid → `getTopicBySession(sessionName)` (R1). Route the routing-critical reads through it, resolving `launchUuid` from the identity each holds: `getThreadId`/`outbound-thread.ts:18` (ws.sessionId+pid), `rebind.ts:58` (sctx), `index.ts` auto-watch loops (SessionInfo pid). Creation/mutation and event-bus keys unchanged.

##### Task 1c-c: remaining lower-traffic sites _(expand after 1c-b)_

`cron/scheduler.ts:48`, `relay-ask.ts:163`, `web/routes/webhook.ts:70` → `topicForSession` with R1 fallback. **Cursor sites** (`cursor/index.ts`, `cursor-bridge.ts`) **stay name-keyed** — carve-out (no launchUuid). `getTopicBySessionId` (AUQ) is already sibling-safe; leave for Task 3.

##### Task 1c → post-1c SOAK GATE _(manual)_

After 1c-a (at minimum): re-run the 2-sibling `/clear` soak. **Success = the `resolveSession_topic_disagree` cross-wire no longer fires** (A's topic keeps its own id). After 1c-b/c: confirm live routing (reply/watch) lands in the correct sibling topic under churn.

### Task 2: Injection targets → `launchUuid`

Route `resolveTmuxTarget` / `resolveCmuxWorkspace` (pane/workspace) by `launchUuid`. `b79123d` already added the sibling-safe "unique same-cwd" recovery; this wires the selection to the registry so it's anchored on the **stable** identity instead of the corruptible one.

**Why (the correctness win, not just consistency):** both functions call `selectRelayTarget(alive, {sessionId, sessionDir, claudePid})`, which tries **`sessionId` first** (`discovery.ts:398`). Under the open lane-2 finding — a sibling's port file gets stamped with THIS session's orphaned `sessionId` under `/clear` churn — `selectRelayTarget({sessionId: A})` returns sibling **B**'s port file, so inject would type A's `/clear` into B's pane/workspace. This is the injection twin of the topic cross-wire Task 1c-a fixed. The `launchUuid` is keyed to the stable claude **pid** (never the rolling/corruptible `sessionId`), so anchoring selection on it removes the wrong-pane vector.

**Design:**

- `launchUuidForPid(pid)` (`resolve-session.ts:121`) reads the watcher snapshot's `launchUuidByPid` (in-memory, no disk). The claude pid is `sctx.sessionPid`; a port file's claude pid is `pf.ppid` (the port file's own `pid` is the relay child). So `launchUuidForPid(sctx.sessionPid)` = target uuid, and `launchUuidForPid(pf.ppid)` = a port file's uuid — one bijective map over live pids.
- **launchUuid-primary branch** (runs first, before the existing `selectRelayTarget` ladder): resolve `targetUuid = uuidForPid(sctx.sessionPid)`. If present, take `alive` port files whose `uuidForPid(pf.ppid) === targetUuid`. Exactly one → return its pane/workspace (or `null` if it carries none — genuinely not tmux/cmux, same "refuse, don't borrow a sibling's" rule as today). Zero or (impossible) >1 → fall through.
- **R1 fallback (UNCHANGED):** when `targetUuid` is `undefined` (Cursor `source:"cursor"`, bare/offline — no snapshot entry), run the **existing** `selectRelayTarget` + unique-cwd (`resolveCmuxWorkspace`: spawn-registry) logic verbatim. Not deleted here — P3b Task 5 removes the cwd heuristic once P3a has soaked.
- **Injectability:** add a 3rd param `uuidForPid: (pid?: number) => string | undefined = launchUuidForPid` to both functions, mirroring the existing `scan`/`lookup` seams. Unit tests set it explicitly; the empty default snapshot means every EXISTING test (which sets no snapshot) resolves `undefined` → exercises the unchanged R1 path → stays green with no edits.
- **Divergence log (soak signal):** when the launchUuid-primary branch selects a DIFFERENT port file than the old `selectRelayTarget({sessionId,…})` would have, `warn("inject: launchUuid overrides sessionId-selected target", {…})`. In steady state they agree (log silent → flip is a no-op); a fire under `/clear` churn is the corruption-fix firing. This is the on-demand analogue of the refresh-tick shadow (inject only runs when the user injects, so a passive shadow yields no data).

Scope: `src/handlers/commands/terminal-inject.ts` (`resolveTmuxTarget`, `resolveCmuxWorkspace`) + `src/__tests__/terminal-inject.test.ts`. Cursor (`injectIntoCursor`/`countSessionsInDir`) and the iTerm/Terminal tty path stay as-is — they don't select a port file by sessionId, so they carry no cross-wire vector here (Cursor keeps its `countSessionsInDir` one-per-folder gate per the audit).

**TDD steps:**

- [ ] **1 (RED):** `resolveTmuxTarget` — new test "prefers the pane of the launchUuid match over a sibling that stole the sessionId": two same-cwd port files, sibling B carries A's `sessionId` + pane `%B`; A's own port file has pane `%A` + `ppid: A_pid`; snapshot maps `A_pid→uA`, `B_pid→uB`; `uuidForPid` from that map. Assert result is `%A` (today's sessionId-first path would return `%B`). Run → FAIL.
- [ ] **2 (GREEN):** add the launchUuid-primary branch + `uuidForPid` param to `resolveTmuxTarget`. Run touched test → PASS.
- [ ] **3 (RED):** mirror test for `resolveCmuxWorkspace` (workspace `wsA` vs stolen-sessionId sibling `wsB`). Run → FAIL.
- [ ] **4 (GREEN):** mirror the branch in `resolveCmuxWorkspace`. Run → PASS.
- [ ] **5:** add the "R1 fallback still works with no snapshot" assertions (no `uuidForPid` hit → existing behavior) — mostly covered by the untouched existing tests; add one explicit "targetUuid undefined → old cwd recovery still fires" per function.
- [ ] **6:** run `bun test src/__tests__/terminal-inject.test.ts` + `bun run typecheck` → all green.
- [ ] **7:** `/code-review`, then commit `feat(identity-p3a): inject resolveTmuxTarget/resolveCmuxWorkspace select by launchUuid (sessionId-corruption-safe)`.

**Post-Task-2 soak (manual):** 2 same-folder siblings (`CLAUDE_CODE_TMUX_FRESH=1 ccd`); `/clear` one; from Telegram inject `/compact` into EACH — confirm it lands in the correct pane, and the divergence `warn` fires only in the corruption-fix direction (never selecting the wrong sibling).

**High-effort code review outcome (folded in before commit):**

- **FIXED (Finding 2, confirmed) — target anchored on the authoritative registry `sessionId → launchUuid`, not the pid.** `sctx.sessionPid` is itself corruptible: `assignPidsToSessions` 2nd pass (`watcher.ts:632`) sets `s.pid = pf.ppid` keyed on a port file's `sessionId`, so a sibling's stolen-id port file can hand this session B's pid. Fix: new `launchUuidBySessionId(records)` (registry.ts, hook-written / re-anchored on `/clear`, port-file-independent) published into the snapshot; `launchUuidForSessionId` helper; `ownPortFileByLaunchUuid` resolves `targetUuid = uuidForSessionId(sessionId) ?? uuidForPid(pid)` — sessionId primary, pid only the pre-hook fallback. The port-file side (`uuidForPid(pf.ppid)`) stays sound (`ppid` = real parent; the pid map is registry-sourced on real claude pids).
- **FIXED (Finding 1, confirmed) — cmux no-workspace-id fallback gated on being alone in the cwd.** `getCmuxWorkspace(dir)` is cwd-keyed (last `/new` spawn wins), so it could return a same-cwd sibling's ref; now returns it only when no sibling shares the cwd, else refuses (`null`).
- **ACCEPTED residuals (documented, not blocking):** Finding 3 (pid reuse selecting a stale-mapped sibling) is now largely mitigated — sessionId is primary, so pid is consulted only when the registry lacks the sessionId (pending window). Finding 4 (`matches.length !== 1` when two live port files share a `ppid`, e.g. a relay-restart artifact) **fails safe** — returns `undefined` → R1 → refuse; no misroute. Finding 5 (the launchUuid selector is parallel to `resolveSession`/`selectRelayTarget`) is a **follow-up**: fold `ownPortFileByLaunchUuid` into the central resolver when `selectRelayTarget` migrates — but that resolver would first need the registry `sessionId` anchor (its current sessionId matching reads the corruptible port file), so it's a deliberate later step.

### Task 3: AUQ bridge `getTopicBySessionId` → `launchUuid`

Cron/relay-ask/webhook (1c-c) and watch-outbound/mode-pin (1c-b) already migrated; the only remaining topic lookup on this list is the AUQ bridge route, explicitly deferred by 1c-c ("`getTopicBySessionId` (AUQ) is already sibling-safe; leave for Task 3").

**Grounding:** `src/web/routes/auq-bridge.ts:85` resolved the topic via `getTopicBySessionId(body.session_id)` — sibling-safe (exact sessionId match) but **brittle to a stale/rolled `sessionId` on the topic record**: after a `/clear` the worker posts the live `session_id`, but if the topic's `sessionId` field hasn't been refreshed the lookup misses → the cwd fallback's `crossesSession` guard rejects it → **404** (or, pre-guard, a misroute). `topicForSession` (1c-b) didn't fit — its R1 fallback is the _name_ lookup, but AUQ holds a `sessionId`, not a `sessionName`.

**Change (done):**

- New `topicForSessionId({launchUuid?, sessionId})` in `topic-store.ts` — mirror of `topicForSession` but the R1 fallback is the sibling-safe `getTopicBySessionId`. No `resolve-session` import (caller passes the launchUuid, avoiding the cycle — same rule as `topicForSession`).
- `auq-bridge.ts` resolves the launchUuid via `launchUuidForSessionId(body.session_id)` (the authoritative registry `sessionId→launchUuid` snapshot map added in the relay-fix lane) and calls `topicForSessionId({launchUuid, sessionId})` — launchUuid-first, sessionId R1 fallback.
- The `findWatchBySessionId` watch lookup above it is **out of scope** — it's the active-/watch store (not the topic store), already exact-match sibling-safe; migrating the watch registry to launchUuid is separate.

TDD: route test — a topic with a **stale** `sessionId` but a matching `launchUuid` resolves by launchUuid (today's sessionId-only path 404s); empty snapshot → sessionId fallback unchanged (all existing route tests stay green). Plus `topicForSessionId` unit tests (exact-id-wins-over-launchUuid; recover-via-launchUuid-when-stale; no-launchUuid → sessionId fallback).

**High-effort review outcome (folded in before commit):** the initial cut was launchUuid-FIRST; the review flagged (PLAUSIBLE) that a launchUuid-first hit **bypasses the cwd `crossesSession` guard**, so a corrupt `sessionId→launchUuid` map entry could misroute an AUQ into a sibling's topic — a safety property the old exact `getTopicBySessionId` match had. **Resolution — flipped to `sessionId`-first, `launchUuid`-fallback:** the exact live-id match (intrinsically sibling-safe) stays authoritative in the healthy case and only falls to `launchUuid` when it misses (the stale-post-`/clear` window the fix targets). Zero loss of the fix's value; the flagged misroute is no longer reachable while the topic's live id matches. This also dissolved the review's duplication finding — `topicForSessionId` is now structurally OPPOSITE to `topicForSession` (whose weaker name fallback justifies ITS launchUuid-first order), not a near-copy. Stale `getTopicByLaunchUuid` "nothing routes on this yet" doc comment fixed.

### Task 4: P3a soak gate _(manual)_

All of Tasks 1–3 shadow-clean over a soak with ≥2 siblings in one folder before P3b deletes anything.

---

## P3b — Delete fallbacks + flip launcher + topic lifecycle

### Task 5: Delete `byDir` / newest-in-dir / `-2` fallbacks _(expand at execution)_

Only after P3a Task 4. Keep the scoped carve-outs (Cursor Composer slug, offline/history scan, pending window).

### Task 6: Auto-delete Telegram topic on session end

> **Depends on Task 1** (topics keyed on `launchUuid`). Do not implement before Task 1 lands — resolving a dead session to its topic by cwd/name would reintroduce the sibling cross-wire this initiative removes, and keying on the raw `sessionId` would miss any topic whose session had `/clear`ed (the id rolls).

**Files:**

- Create: `src/sessions/topic-reaper.ts`
- Test: `src/__tests__/topic-reaper.test.ts`
- Modify: `src/sessions/watcher.ts` (call the reaper in the refresh, ~line 294 after `getRunningClaudeProcesses()`)

**Interfaces:**

- Consumes:
  - `RegistryRecord[]` from `readRegistry()` (`src/sessions/registry.ts`).
  - `getRunningClaudeProcesses(): Promise<ClaudeProcess[]>` (`src/sessions/watcher.ts:139`) — has `pid`.
  - `topicManager.deleteTopic(key: string): Promise<void>` — deletes the forum topic (`deleteForumTopic(chatId, topicId)`), removes the mapping, and writes a ledger tombstone. `key` is whatever the topic is bound to after Task 1 (`launchUuid`).
- Produces:
  - `planTopicDeletions(records: RegistryRecord[], livePids: Set<number>, deaths: Map<string, number>, opts: { threshold: number; inGrace: boolean }): { toDelete: string[]; deaths: Map<string, number> }` — **pure**. For each record: if `record.claudePid` is in `livePids`, reset its death count to 0; else increment. A record whose count reaches `threshold` while `inGrace` is false yields its `launchUuid` in `toDelete` (and is cleared from `deaths`). During grace (`inGrace === true`), counts do not increment (returns them unchanged) and `toDelete` is empty. Returns the next-tick `deaths` map.
  - `reapDeadTopics(deps): Promise<string[]>` — IO wrapper: reads registry + live pids, calls `planTopicDeletions`, `await`s `deleteTopic` for each `toDelete` that still has a bound topic, returns the deleted keys. Persists `deaths` across ticks (module-level or passed in).

**Design notes (why each guard):**

- **Consecutive-tick threshold** (default `threshold: 2`) absorbs a single missed detection tick — one flaky `ps` read must not delete a topic. Mirrors the offline-flap buffer in `notifications`.
- **Startup grace** (`inGrace` true for the first ~30s after boot, or until the first full `getRunningClaudeProcesses()` completes) prevents a bot restart from mass-deleting every topic before it has re-observed the live pids.
- **`/clear` is safe by construction:** pid is unchanged → in `livePids` → count resets. Only a real process exit removes the pid.
- **Resume/`--continue`:** a new process → new `launchUuid` → new topic; the old process is already dead, so its topic is deleted. This is the mechanism that dissolves audit edge R4 (respawn topic reuse) — there is no stale topic to reconcile.
- **Records with no bound topic** (pre-Task-1 sessions, or already-deleted): `deleteTopic` is a no-op / skipped; `planTopicDeletions` still clears the death count so it doesn't spin.

- [ ] **Step 1: Write the failing test for `planTopicDeletions` — live pid resets count**

Create `src/__tests__/topic-reaper.test.ts`:

```ts
import { planTopicDeletions } from "../sessions/topic-reaper";
import type { RegistryRecord } from "../sessions/registry";

const rec = (launchUuid: string, claudePid: number): RegistryRecord => ({
  launchUuid,
  claudePid,
  startTime: "x",
  sessionId: "s",
  cwd: "/c",
  source: "test",
  updatedAt: "2026-07-07T00:00:00Z",
});

test("a live pid resets its death count and never deletes", () => {
  const records = [rec("u1", 100)];
  const live = new Set([100]);
  const { toDelete, deaths } = planTopicDeletions(
    records,
    live,
    new Map([["u1", 1]]),
    { threshold: 2, inGrace: false },
  );
  expect(toDelete).toEqual([]);
  expect(deaths.get("u1") ?? 0).toBe(0);
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**

Run: `bun test src/__tests__/topic-reaper.test.ts`
Expected: FAIL — `Cannot find module '../sessions/topic-reaper'`.

- [ ] **Step 3: Minimal `planTopicDeletions`**

Create `src/sessions/topic-reaper.ts`:

```ts
import type { RegistryRecord } from "./registry";

export function planTopicDeletions(
  records: RegistryRecord[],
  livePids: Set<number>,
  deaths: Map<string, number>,
  opts: { threshold: number; inGrace: boolean },
): { toDelete: string[]; deaths: Map<string, number> } {
  const next = new Map(deaths);
  const toDelete: string[] = [];
  for (const r of records) {
    if (livePids.has(r.claudePid)) {
      next.set(r.launchUuid, 0);
      continue;
    }
    if (opts.inGrace) continue; // freeze counts until we trust liveness
    const n = (next.get(r.launchUuid) ?? 0) + 1;
    if (n >= opts.threshold) {
      toDelete.push(r.launchUuid);
      next.delete(r.launchUuid);
    } else next.set(r.launchUuid, n);
  }
  return { toDelete, deaths: next };
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `bun test src/__tests__/topic-reaper.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the dead-pid threshold + grace + resume tests**

Append:

```ts
test("a dead pid deletes only after threshold consecutive misses", () => {
  const records = [rec("u1", 100)];
  const live = new Set<number>(); // pid gone
  let deaths = new Map<string, number>();
  ({ deaths } = planTopicDeletions(records, live, deaths, {
    threshold: 2,
    inGrace: false,
  }));
  // first miss: counted, not deleted
  let out = planTopicDeletions(records, live, deaths, {
    threshold: 2,
    inGrace: false,
  });
  expect(out.toDelete).toEqual(["u1"]); // second miss reaches threshold
});

test("grace window freezes counts — no deletion during startup", () => {
  const records = [rec("u1", 100)];
  const out = planTopicDeletions(records, new Set(), new Map([["u1", 1]]), {
    threshold: 2,
    inGrace: true,
  });
  expect(out.toDelete).toEqual([]);
  expect(out.deaths.get("u1")).toBe(1); // unchanged
});

test("a single missed tick then recovery never deletes", () => {
  const records = [rec("u1", 100)];
  let deaths = new Map<string, number>();
  ({ deaths } = planTopicDeletions(records, new Set(), deaths, {
    threshold: 2,
    inGrace: false,
  })); // miss -> 1
  const out = planTopicDeletions(records, new Set([100]), deaths, {
    threshold: 2,
    inGrace: false,
  }); // back
  expect(out.toDelete).toEqual([]);
  expect(out.deaths.get("u1")).toBe(0);
});
```

- [ ] **Step 6: Run all reaper tests — expect PASS**

Run: `bun test src/__tests__/topic-reaper.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Write the IO wrapper `reapDeadTopics`**

Append to `src/sessions/topic-reaper.ts` (wire real deps; keep `deaths` at module scope so it persists across ticks):

```ts
import { readRegistry } from "./registry";

let deaths = new Map<string, number>();

export async function reapDeadTopics(deps: {
  livePids: Set<number>;
  inGrace: boolean;
  hasTopic: (launchUuid: string) => boolean;
  deleteTopic: (launchUuid: string) => Promise<void>;
  log?: (msg: string, meta?: unknown) => void;
}): Promise<string[]> {
  const records = readRegistry();
  const res = planTopicDeletions(records, deps.livePids, deaths, {
    threshold: 2,
    inGrace: deps.inGrace,
  });
  deaths = res.deaths;
  const deleted: string[] = [];
  for (const uuid of res.toDelete) {
    if (!deps.hasTopic(uuid)) continue; // pre-Task-1 session / already gone
    try {
      await deps.deleteTopic(uuid);
      deleted.push(uuid);
      deps.log?.("topic-reaper: deleted topic for ended session", {
        launchUuid: uuid,
      });
    } catch (e) {
      deps.log?.("topic-reaper: deleteTopic failed", {
        launchUuid: uuid,
        err: String(e),
      });
    }
  }
  return deleted;
}
```

- [ ] **Step 8: Wire into the watcher refresh**

In `src/sessions/watcher.ts`, after `getRunningClaudeProcesses()` (~line 294), build `livePids` from the running processes and call `reapDeadTopics` with the topic-manager deps. Compute `inGrace` from a boot timestamp (grace until first successful process scan completes or ~30s elapsed). Wrap in try/catch — a reaper failure must never break the refresh.

- [ ] **Step 9: Run the watcher + reaper suites**

Run: `bun test src/__tests__/topic-reaper.test.ts src/__tests__/watch.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/sessions/topic-reaper.ts src/__tests__/topic-reaper.test.ts src/sessions/watcher.ts
git commit -m "feat(identity-p3): auto-delete Telegram topic on session end (debounced, grace-guarded)"
```

### Task 7: Flip launcher to always-create — DONE (commit a977e78)

`scripts/tmux/launch.sh` rewritten: always-create; dropped the `--session-id` pin (`_cc_uuid`/`_cc_should_pin_id`), the reap (`_cc_reap_detached`), and the attach/decide logic; unique name `cc-<base>-<hash8>-<pid>` (kept the path hash so same-basename repos don't collide, added the pid for per-launch uniqueness); kept `-L claude` socket + `claude-tmux.conf`; claude argv passed through verbatim so `--resume`/`--continue` still work. Rewrote `launch.test.sh` (always-create, unique-name, no-pin, no-attach). Safe now because P3a routes by launchUuid, so multiples no longer spam the topic watcher.

### Task 8: Topic create-on-start bound to `launchUuid` — SATISFIED BY EXISTING CODE

Investigation showed the functional goal is **already met**, so no new mechanism was built (building one would duplicate/conflict with the existing create flow):

- **Create-on-start already exists** at runtime: `createNotificationHandler` (index.ts) creates a topic via `topicManager.createTopic` the moment the watcher detects a new session (not only at startup `reconcile`).
- **launchUuid binding at creation already exists** (Task 1a): `_createTopicImpl` (topic-manager.ts:147) resolves the session's launchUuid and stores it on the mapping at creation; the watcher's per-refresh backfill fills it in if the id wasn't resolvable yet.
- **One topic per sibling already follows from Task 7**: unique per-session names (`cc-<base>-<hash8>-<pid>`) → distinct `sessionName`s → the create flow makes a distinct topic for each.

So Task 8 = confirm + a doc-comment fix (the stale "nothing routes on this yet" note at `_createTopicImpl`, now false — Tasks 1c/2/3 route on launchUuid and Task 6 reaps by it). The one piece NOT done is the cosmetic `<base>-<uuid8>` **display name** — that's coupled to the `-2`/hash naming scheme removed in the HELD Task 5, so it's deferred with Task 5 rather than done in isolation.

---

## Final whole-branch review

After all tasks: dispatch the final code reviewer on the most capable model, pointed at the Minor-findings roll-up in the ledger. Then use superpowers:finishing-a-development-branch.
