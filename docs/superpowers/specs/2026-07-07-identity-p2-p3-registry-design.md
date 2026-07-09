# Identity P2/P3 — Hook-Minted Registry + Multi-Session-Per-Folder — Design

> **Status:** Design (brainstormed + approved 2026-07-07). Successor to the P1
> `resolveSession` consolidation (merged in #60) and the find/identify audit
> (`docs/superpowers/notes/2026-07-06-identity-find-identify-audit.md`).

## 1. Goal

Run **multiple `ccd` sessions in the same folder, each correctly resolved to its
own Telegram topic** — inject (`/clear`·`/compact`·`/context`), reply, and
observe each session independently, with no sibling cross-wire and no "🔄 started
a new conversation" spam. Achieve this by giving every session a **stable
identity** the bridge routes on, instead of inferring identity from the
filesystem (`newest .jsonl in dir`, cwd guessing) — which is the root cause of the
whole routing bug class.

This is the **full P2/P3 consolidation** (not a minimal slice): the hook is the
single source of identity for all sessions; every find/identify site routes
through the registry; the `byDir`/newest-in-dir/`-2` fallbacks are deleted.

## 2. Core model — hook-minted `launchUuid` + registry

**The `SessionStart` hook is the single source of the stable id.** On its first
fire for a process, it **mints a `launchUuid`** (a fresh UUID) keyed on
`pid + process-start-time`, and persists it to the **registry**. On every later
fire (`/clear`, resume, `--continue`, compact) it looks up that `pid+startTime`
and **re-anchors the rolling `sessionId`** onto the same record.

- **`launchUuid` is stable** for the life of the process; **`sessionId` rolls** on
  `/clear`/resume and is a mutable field.
- Keyed on `pid+startTime` (not pid alone) so OS pid-reuse can't collide.
- Minted **from inside the session** (the hook knows its own pid + session_id
  directly) → race-free, needs no relay port file, and **covers every session
  that runs the hook** — CLI in a terminal, CLI in a Cursor integrated terminal,
  bare `claude`, ralph iterations.

**The registry is the single source of truth**, one record per session, keyed on
`launchUuid`:

```
{ launchUuid, sessionId (rolls), pid, startTime, cwd,
  tmuxPane, tmuxSocket, cmuxWorkspaceId, relayPort, topicId, source, jsonlPath }
```

**Every find/identify becomes one registry lookup by id.** A miss **fails loud**
— scoped to hook-bearing sessions (see carve-outs). Because each session owns a
distinct `launchUuid`, N sessions in one folder are individually addressable —
the goal.

### 2.1 Carve-outs (must preserve, from the audit)

- **Cursor Composer** (`source:"cursor"`, the CDP Composer bridge — NOT the CLI
  running in Cursor's integrated terminal, which does get the hook) has no Claude
  hook → keeps its synthetic `cursor-<slug>` as its id. Fail-loud does not apply.
- **Offline / history discovery** (`listOfflineSessions`, history-for-unknown-id)
  has no live registry entry → stays filesystem-scan; explicitly exempt from
  "delete all fallbacks."
- **Pre-hook startup race:** a session can exist before the hook has minted its id
  (~spawn window). The registry returns a **`pending`** state (distinct from a
  hard miss) so routing retries rather than failing — preserving today's ~6s
  spawn-poll semantics (`startWatchingSession`).

## 3. Topic model — 1:1 with session, bound to `launchUuid`

- **Create on session start:** when the hook mints a `launchUuid` and the registry
  entry appears, create a fresh Telegram topic bound to that `launchUuid` (not
  `sessionName`). Display name `<base>-<uuid8>` (render-only; the `-2` scheme is
  removed). Display name is renameable and never a lookup key.
- **Survive `/clear`:** the process persists (same pid), so the topic stays; only
  the `sessionId` field re-anchors.
- **Auto-delete on session end:** when the session's pid dies (detected by the
  existing liveness reaper), delete its topic. Must debounce transients (bot
  restart, brief process-detection miss) so a live session isn't wrongly reaped.
- **N sessions in one folder → N topics**, each bound to its own `launchUuid`,
  each routed independently.

Because topics die with their sessions, the audit's hardest edge — **R4
(respawn/resume topic reuse)** — dissolves: resume/`--continue` is a new process
→ new session → new topic; there is no stale old topic to reconcile.

## 4. Launcher (`scripts/tmux/launch.sh`) — flip to always-create

The P1 launcher optimized for "one session per folder" (attach-or-create + reap),
which is the opposite of this goal. Unwind it:

- **Always-create** — every `ccd` starts its own session (no attach-to-existing).
- **Drop the `--session-id` pin** (`_cc_uuid`/`_cc_should_pin_id`) — unnecessary;
  the hook is the sole id source.
- **Unique tmux name** `cc-<base>-<pid>` (distinct so siblings coexist; the uuid
  lives in the registry, not the name).
- **Drop the reap** — a detached session is now a **legitimate persisted parallel
  session** (close Cursor → it survives → reattach later), not an orphan. Reaping
  would kill exactly what the user wants.
- **Self-cleaning lifecycle:** `exec claude` means a session self-closes when
  Claude exits → registry pid dies → topic auto-deletes. Persistence is managed by
  the user via `ccls`/`cckill`; topics track it automatically.
- Keep the `-L claude` dedicated socket + `claude-tmux.conf` (`destroy-unattached
off`, status bar on).

## 5. Routing migration — sites and order

Every "which session is this" site moves to a registry lookup by id, each behind a
**shadow → soak → migrate** gate (the P1 Task-6 pattern), in this order:

1. `selectRelayTarget` — **already migrated** (P1 Task 6).
2. **Topic ↔ session** (`getTopicBySession`/`getThreadId` + the ~15 `sessionName`
   -keyed sites) — the lockstep move: repoint every name lookup to `launchUuid`.
   Done **all at once** (the audit's premise correction: half-migrating makes
   siblings resolve to the wrong record).
3. **Injection** (`resolveTmuxTarget`/`resolveCmuxWorkspace`) — route pane/tty/
   workspace by id. `b79123d` already added the sibling-safety; this wires it to
   the registry.
4. **AUQ/auq-bridge**, **cron**, **auto-watch outbound** — id lookups.
5. **Delete the fallbacks** (`byDir`, newest-in-dir, `-2`) — last, gated on all the
   above soaking clean.

**Fail-loud is scoped:** only hook-bearing sessions fail-loud on a registry miss.
Cursor Composer (slug), offline/history, and the pre-hook `pending` window keep
their lookups.

## 6. Phasing (keeps live routing safe)

This is the **hottest path** in the app (live message routing). Each phase is
independently shippable, shadow/soak-gated, restart-verified — like WS-3c.

- **P2 — writer side.** The hook mints `launchUuid` + writes the registry keyed on
  it; `resolveSession` prefers the `launchUuid` for hook-bearing sessions, current
  logic as fallback. Nothing deleted. Registry emits observe-only divergence logs.
- **P3a — migrate consumers.** Move the sites in §5 (topic lockstep, injection,
  AUQ/cron/auto-watch) onto the registry, each shadow-gated. Backfill existing
  on-disk topic-store / topic-ledger / cron records with `launchUuid` here.
- **P3b — delete + flip.** Delete `byDir`/newest-in-dir/`-2`; flip the launcher to
  always-create + no-pin + no-reap; enable topic create-on-start + auto-delete-on-
  end. **Only after P3a soaks clean.**

## 7. Components (units, boundaries)

- **Hook** (`hooks/claude-remote-session-id.ts`) — mints/persists `launchUuid`
  keyed `pid+startTime`; re-anchors `sessionId` on later fires. Sole id writer.
- **Registry** (new module, e.g. `src/sessions/registry.ts`) — the keyed store
  `{launchUuid → record}` + a `pending` state for the spawn window + a liveness
  reaper (reuses `getRunningClaudeProcesses`). One responsibility: hold + serve
  identity by id.
- **`resolveSession`** (`src/sessions/resolve-session.ts`, from P1) — grows a
  `launchUuid`-primary path; consumers already call it.
- **Topic manager** (`src/topics/`) — create-on-start bound to `launchUuid`,
  survive-`/clear`, auto-delete-on-end; drop the `-2` scheme.
- **Launcher** (`scripts/tmux/launch.sh`) — always-create, no-pin, no-reap.

## 8. Error handling

- Registry miss on a **hook-bearing** session → fail loud (log + surface), do NOT
  guess. On a **non-hook** session (Cursor Composer) or during the **pending**
  window → fall through to the scoped lookup / retry.
- Topic auto-delete must debounce transient pid-absence (bot restart / detection
  miss) to avoid deleting a live session's topic.
- Pid-reuse guarded by keying on `pid+startTime`.

## 9. Testing

- **Hook:** mint-on-first-fire; re-anchor sessionId on later fire; pid+startTime
  keying; idempotent.
- **Registry:** lookup by each handle; `pending` vs `miss`; liveness reaping;
  pid-reuse non-collision.
- **Topic lifecycle:** create-on-start; survive-`/clear`; auto-delete-on-end;
  debounce transient absence; two siblings in one folder → two topics, no cross.
- **Migration:** each consumer site — shadow shows zero divergence before migrate;
  adversarial two-sibling routing/inject.
- **Launcher (bash):** always-create; unique names; no attach; no reap; drop
  `--session-id`.
- **Regression:** the reported misroute scenarios (sibling cross-wire, `/clear`
  staleness) resolve correctly.

## 10. Out of scope / deferred

- Cursor Composer identity redesign (keeps its slug).
- Offline/history discovery redesign (stays filesystem-scan).
- `--session-id`-based identity (dropped in favor of hook-mint).
- The origin-topic outbound refactor (D1/D2/D3) is **already merged** and
  complementary — this spec does not touch reply-destination routing.
