# Session-Identity Consolidation — Spec

> **Status:** Draft for review. This is a _design spec_, not yet a task-by-task
> implementation plan. Once the direction here is approved, a
> `docs/superpowers/plans/` plan with bite-sized TDD tasks is written from it.

**Author:** session 2026-06-26 (continuing the AUQ/relay work)
**Related:** [[project_sibling_session_misroute]], [[project_auq_relay_no_bus_feed]],
commits `d084054` (SessionStart hook), `bdae315` (sibling routing), `b4cfc80`
(encoding + backfill re-run).

---

## 1. Problem

We keep shipping the **same class of bug**. Of the last 200 commits, 73 are
fixes, and **56 of those 73 (77%) are about resolving _which Claude session is
which_**: `watch` mis-binding, sibling cross-wiring, session-id flap/drift,
discovery races, backfill, AUQ routing by cwd.

Two bugs _this week_ are textbook instances:

- **`bdae315`** — two sessions in one folder cross-wired, because routing
  guessed by `cwd` instead of the exact `sessionId`.
- **`b4cfc80`** (today) — sibling sessions had no `sessionId` at all, because
  (a) the cwd→project-dir encoder only replaced `/` (not `_`/`.`), so JSONL
  discovery looked in a directory that never exists, and (b) the rescue sweep
  ran _once at startup_ and never again.

### 1.1 Root cause

**Session identity is inferred from filesystem side-channels rather than taken
from an authoritative source, and the inference is spread across four stores
that must agree.**

The four views of "which session":

| Store                                                     | Owner             | How identity gets in                                               |
| --------------------------------------------------------- | ----------------- | ------------------------------------------------------------------ |
| Relay **port file** (`channel-relay-*.json`)              | relay MCP server  | self-discovery by JSONL birthtime/mtime, OR the SessionStart hook  |
| **Topic store** (`topics.json`)                           | bot topic-manager | copied from the watcher registry at topic creation                 |
| **Watcher registry** (in-memory `SessionInfo`)            | bot watcher       | `scanSessions()` reconciling port files + `ps`/`lsof` + JSONL scan |
| **JSONL on disk** (`~/.claude/projects/<enc>/<id>.jsonl`) | Claude Code       | ground truth, but only addressable via the cwd encoding            |

Every heuristic that bridges these has edge cases — same-dir siblings, `/clear`
spawning a new transcript, `--resume` drifting the id, an `_` in the path,
startup races. Each fix patches one heuristic; the next real-world condition is
the next commit. **That is the treadmill.**

### 1.2 The authoritative path already exists — but isn't guaranteed

`d084054` added a **SessionStart hook** (`hooks/claude-remote-session-id.ts`)
that writes each process's own `session_id` into its relay port file, matched by
pid ancestry to the relay's parent. This is the _correct_ mechanism: identity
from the source, not a guess. But it was landed as **additive** — the JSONL-scan
poll and backfill remain as fallback, and the hook:

- is only auto-injected by `scripts/claude-relay-launch.sh`; **hand-started
  sessions** (and the live `kinetix-agents` sessions this week) don't run it;
- has **no hot-reload** — a session started before the hook existed never gets it;
- **silently no-ops** when it doesn't fire — indistinguishable from working.

So in practice we still fall back to guessing, and the guesses still break. The
consolidation is: **make the authoritative path the only path, guarantee it
runs, and make every remaining fallback loud.**

---

## 2. Goals / Non-goals

**Goals**

1. One authoritative source of session identity (`sessionId ↔ claudePid ↔ cwd`),
   produced at SessionStart, that the other three stores _derive from_ rather
   than independently infer.
2. Eliminate silent disagreement: when stores diverge, _log it_, don't pick.
3. Guarantee the identity hook is installed and detect (loudly) when a live
   session lacks it.
4. Kill duplicated logic that drifts (encoders, ancestry walks) — single helpers.
5. Replace example-based tests for the resolver with adversarial/property tests
   covering the conditions that actually bite (N siblings, weird paths, resume).

**Non-goals**

- Rewriting the relay transport, the topic/Telegram layer, or the Cursor bridge.
- Removing the heuristic fallback entirely _in one step_ — it stays as a clearly
  bounded, observable last resort until hook coverage is proven in the wild.
- Changing Claude Code itself. We only consume what its hooks expose.

---

## 3. Target architecture

```
SessionStart hook (per Claude process)
        │  writes {sessionId, claudePid, cwd} — authoritative, instant
        ▼
  Relay port file  ──────────────►  Identity Resolver (single module)
        ▲                                   │  one canonical map:
  JSONL scan (fallback, LOUD) ──────────────┤  sessionId ↔ claudePid ↔ cwd ↔ topic
                                            │  + invariant checks
                                            ▼
        ┌───────────────┬───────────────────┬───────────────┐
        ▼               ▼                   ▼               ▼
  watcher registry   topic store        AUQ bridge      relay selector
  (derives)          (derives)          (reads)         (reads)
```

Principles:

- **One module owns identity.** Today resolution logic lives in `watcher.ts`
  (`resolveSiblingId`, `scanSessions`), `relay/discovery.ts` (`selectRelayTarget`),
  `relay/backfill.ts`, and the relay server's `discoverSessionId` — four places
  with overlapping rules. Consolidate the _rules_ behind one resolver the others
  call, even if the data still physically lives in multiple files.
- **Authoritative beats inferred, always.** A hook-written `sessionId` is never
  overridden by a JSONL-scan guess.
- **Never guess across siblings.** When >1 live session shares a cwd and the
  authoritative id is missing, resolve to _nothing_ and log — never pick by
  mtime. (`resolveSiblingId` already does this for the registry; the same rule
  must hold in the relay server's `discoverSessionId` and in `backfill`.)
- **Disagreement is observable.** A reconciler compares the four stores and logs
  a structured warning when they diverge, instead of one store silently winning.

---

## 4. Design decisions

Each decision lists the recommended option first.

### D1 — Guarantee the identity hook runs (and detect when it doesn't)

**Recommend:** (a) install the SessionStart hook into the _user_ `settings.json`
(not just the launch script) so every session — launched or hand-started —
inherits it; (b) add a **startup + per-refresh self-check**: for every live
relay whose port file lacks a hook-written id after a grace period, emit a single
loud `WARN` naming the cwd/pid. This converts the invisible failure mode (today's
kinetix bug) into a visible one. _Builds on the same "make silent bails loud"
idea shipped for the AUQ hook in `14b994f`._
**Alternative:** keep auto-injection launcher-only — rejected, that's the current
gap that left the live sessions hookless.

### D2 — Single Identity Resolver module

**Recommend:** introduce `src/sessions/identity.ts` exposing one resolver that
takes the raw inputs (port files, running pids, hook-written ids) and returns the
canonical `sessionId ↔ claudePid ↔ cwd ↔ topic` mapping with an explicit
provenance field (`authoritative` | `inferred` | `ambiguous`). `watcher.ts`,
`discovery.ts`, `backfill.ts`, and the AUQ bridge consume it; none re-derive.
**Alternative:** leave logic distributed but extract shared helpers only —
weaker; the bugs come from the _rules_ drifting between sites, not just code dup.

### D3 — One encoder, enforced

**Recommend:** `claudeProjectDir` now lives once in `paths.ts` (done in
`b4cfc80`). Add a lint/grep guard in CI that fails if `.claude/projects` or
`replace(/\//g` reappears outside `paths.ts`, so a fourth copy can't silently
drift back in.
**Alternative:** rely on review — rejected, this exact dup survived multiple
reviews.

### D4 — Reconciler with invariant checks

**Recommend:** a periodic reconcile pass (fold into the watcher's `doRefresh`)
asserts the invariants and logs violations:

- every live relay has exactly one `sessionId`;
- no `sessionId` maps to two topics;
- topic-store `sessionId` == registry `sessionId` == port-file `sessionId`;
- a topic's cwd encodes to a real project dir.
  Violations log structured `WARN`s (and optionally surface in `/cleanzombie`).
  **Alternative:** assert-and-throw — rejected, must not crash the bot on drift.

### D5 — Bounded, observable fallback (don't delete yet)

**Recommend:** keep JSONL-scan discovery + backfill as the _only_ fallback, gated
behind "no authoritative id AND not ambiguous-across-siblings," and have it log
`provenance=inferred` every time it fires. Add a metric/log counter so we can see
_how often_ we still guess. Plan to delete it once that counter trends to zero in
real use.
**Alternative:** delete fallback immediately on D1 landing — too risky before
hook coverage is proven; revisit after a soak period.

---

## 5. Workstreams

Each is independently shippable and testable. Order is dependency-driven.

- **WS-1 — Observability first (no behavior change).** D4 invariant checks + D1
  self-check warnings + D5 `provenance` logging. Lands the _visibility_ before we
  change resolution, so we can measure the real failure rate and catch
  regressions. Lowest risk, highest immediate diagnostic value.
- **WS-2 — Guarantee the hook (D1).** User-settings install + install-script
  update + docs; verify a hand-started session gets an authoritative id.
- **WS-3 — Identity Resolver (D2).** Extract the single resolver with provenance;
  re-point watcher/discovery/backfill/AUQ at it. Pure refactor guarded by the
  WS-1 invariants + existing tests.
- **WS-4 — Adversarial test suite (§6).** Property/scenario tests for the
  resolver. Can start in parallel with WS-3.
- **WS-5 — Enforce single encoder (D3).** CI guard.
- **WS-6 — Soak & prune (D5).** After WS-1 visibility shows `inferred` ≈ 0,
  remove the heuristic fallback.

---

## 6. Test strategy

The recurring bugs slipped because tests used **one happy example** (and
sometimes mirrored the bug — today's `_helpers.ts` encoded slashes-only just like
the code it tested, so it never caught the encoder). Fixes:

- **Adversarial scenario matrix** for the resolver: 1/2/3 sessions per dir;
  cwd containing `_`, `.`, spaces, unicode; `/clear` mid-session (new JSONL,
  same pid); `--resume` (id drift); relay started before vs after the hook;
  port file present but JSONL not yet written.
- **Property test:** for any set of live sessions, the resolver never maps two
  distinct pids to the same `sessionId`, and never maps one topic to two ids.
- **Anti-mirroring rule:** fixtures must encode via the production helper
  (`claudeProjectDir`), never a local re-implementation. WS-5's CI guard enforces
  this for test files too.
- **Invariant tests** for D4: construct each violation, assert it's logged.

---

## 7. Risks & migration

- **Hook in user settings affects _all_ Claude sessions on the machine**, not
  just bridge ones. Mitigation: the hook already exits 0 / stdout-silent and does
  one `ps` + one `readdir`; verify it's a true no-op for non-relay sessions
  (no port file → nothing to write).
- **Refactor risk in WS-3** (touching the hottest, most-patched code). Mitigation:
  WS-1 invariants + the existing isolated suite gate it; ship as a pure refactor
  with no behavior change, behind the new tests.
- **Soak dependency:** WS-6 (prune) must not start before WS-1 data proves the
  fallback is unused. Explicitly sequenced last.
- **Live sessions:** existing hookless sessions self-heal via backfill (post
  `b4cfc80`) until relaunched; no forced restart required.

---

## 8. Open questions — RESOLVED 2026-06-26

1. **Scope of the hook install** — ✅ **Global user `settings.json`** (covers
   hand-started sessions too). Approved by AZ.
2. **Persist the canonical map?** — ✅ **Rebuilt each refresh** from port files;
   no fifth store. (Recommended default, taken.)
3. **Surface violations to the user?** — ✅ **Logs-only first**; a Telegram
   `/health` line can come later. (Recommended default, taken.)
4. **Soak length before WS-6 prunes the fallback** — ✅ **Metric-gated**:
   `inferred`/`missing` count == 0 across N restarts, not a fixed calendar
   window. (Recommended default, taken.)

First implementation increment (WS-1) is planned in
`docs/superpowers/plans/2026-06-26-identity-observability-ws1.md`.

---

## 9. Out of scope

- Relay transport / dual-path outbound consolidation (separate "Option B" work,
  see [[project_relay_arch]]).
- tmux-less AUQ answer delivery (separate; tracked in the AUQ handover).
- Cursor CDP identity (synthetic ids; a different mechanism).
