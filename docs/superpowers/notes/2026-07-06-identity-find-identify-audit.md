# Find/Identify audit — pin-id-at-birth strategy (2026-07-06)

Consolidated from a 4-domain parallel code sweep. Question asked: _does the
proposed strategy lose anything or create new edge cases?_ **Answer: the strategy
is directionally right and collapses the whole routing bug class — but it is NOT
lossless as stated. It loses coverage in ~6 specific places unless each gets an
explicit carve-out.** None is fatal; all are designable. Details below.

## The proposed strategy (recap)

1. Every session born with a stable **launch-uuid**, pinned via `claude --session-id <uuid>` and/or the SessionStart hook.
2. ONE registry keyed on launch-uuid: `{launchId, tmuxName/pane, displayName, cwd, pid, sessionId(rolls), jsonlPath, relayPort, topicId, app}`.
3. `sessionId` mutable, re-anchored on `/clear`.
4. All find/identify → registry lookup by id; delete every `byDir`/newest-in-dir/first-match/frontmost fallback.
5. A registry MISS fails loud.
6. Name always `<base>-<uuid8>`, drop the `-2` scheme.

## Clean wins (confirmed by the code)

- **Injection targeting** becomes exact for tmux (pane id), cmux (workspace UUID), iTerm2/Terminal (tty from pid). These are already id-shaped; they just use the wrong _key_ (rolling sessionId) today, forcing the `byDir` crutch.
- The model genuinely collapses **sibling cross-wire**, **`/clear` staleness**, and **name-swap-on-restart** — three separate reported bug classes.
- `findSessionJsonlPath(id)` (`tailer.ts:829`) is _already_ the "registry lookup by id" primitive the strategy wants — the clean template.
- Detection-only code (`identity-invariants`, `identity-report`, `identity-shadow`) is the seed of "fail loud" and already never guesses.

## The premise correction (important)

The topic-store's real primary key is **`sessionName`**, NOT `sessionId`
(`topic-store.ts`). `sessionId` keying exists in only 2 sites (AUQ `getTopicBySessionId`,
cron). So "stop keying on the rolling sessionId" **understates the work**: ~15 call sites
key on `sessionName`, and the `-2` suffix is a **lookup token**, not decoration — it flows
into topic-store keys, port-file `topicName` matching, watch-registry keys, and event-bus
channel names. Dropping `-2` / going display-only is safe **only if every name lookup moves
to the uuid in lockstep**. Half-migrating makes siblings silently resolve to the wrong record.

## Must-fix carve-outs (what's lost / new edge cases)

### R1 — Non-launcher sessions have no uuid → fail-loud breaks them _(all 4 agents)_

Cursor (no Claude hook; id is synthetic `cursor-<slug>`), bare `claude`, ralph
iterations, and `--resume`/`--continue` never pass through the alias and never pin
`--session-id`. Today the launcher (`scripts/claude-relay-launch.sh:73`) doesn't pin it
_at all_. For these the only id source is the SessionStart hook, which can't attribute a
session owning no relay port file. **A MISS that "fails loud" would break these common
sessions.** → Fail-loud MUST be scoped to launcher-born sessions; keep a legitimate lookup
for the rest; define `uuid := cursor-<slug>` for Cursor and branch on the existing
`SessionInfo.source` field.

### R2 — Ordering: pin the id BEFORE deleting fallbacks _(session-res + injection)_

Every `byDir` fallback exists solely to survive `sessionId` drift across `/clear`. Deleting
them before the uuid is actually pinned re-opens the exact bug that 255e2b9 / f833c16 /
bdae315 fixed. Sequence is non-negotiable: (a) mint+pin the uuid in the launcher AND the
hook, (b) carry it on the port file (`PortFileData` has no such field today), (c) soak, then
(d) delete fallbacks.

### R3 — Pre-hook startup race is still unsolved (WS-2) _(session-res + reply)_

The registry entry must EXIST before the first message/watch binds. Today
`discoverSessionId` + backfill + newest-in-dir poll paper over a ~15s spawn window. A
registry with only the racing hook as its writer reintroduces the 2026-06-26 sibling
incident. → The registry needs a **pending/retry state distinct from a hard MISS**;
fail-loud must not fire during the spawn window (`startWatchingSession` already polls 6s —
preserve that semantics).

### R4 — respawn / resume must reuse the OLD topic _(topic + session-res)_

`/respawn` deliberately reuses the topic today _because the new process gets the same
basename_ (`sessions.ts:265`). A pure per-launch uuid mints a NEW id → would spawn a
DUPLICATE topic. → The hook must distinguish fresh-launch vs `/clear` vs resume vs respawn
and **carry the prior launch-uuid forward** in the latter three. Hardest under-specified
edge; trades the `/clear` bug for a "respawn duplicates the topic" bug if ignored.

### R5 — Offline / historical discovery is inherently registry-less _(session-res)_

`listOfflineSessions`, `findLatestJsonlForDir`, and history's dir-fallback serve sessions
with no live process, no port file, no registry entry. → "Delete all mtime/dir fallbacks"
must **explicitly exempt read-only historical/offline discovery**, or `/list` offline and
history-for-unknown-id silently return nothing.

### R6 — A stable KEY doesn't fix a stale VALUE _(reply-routing)_

`topicId` is a mutable value and is exactly what went wrong in every reported misroute.
Keying on launch-uuid prevents _identity_ confusion, not _topic_ staleness. Solicited
replies (`sendViaRelay` origin path, `wireRelayDisplay`, ask_remote answer round-trip)
already honor the request-carried origin topic and are NOT the corrupt-able path — the
registry is **redundant** for them. The registry genuinely helps only: (a) relay-PORT
selection (`selectRelayTarget`) and (b) **unsolicited** output (auto-watch stream, cron,
cursor cross-post). → Registry and the origin-topic refactor are **complementary, not
substitutes**: registry answers "who/where is this session," origin-topic answers "where
does this reply go." Finish the origin-topic refactor (propagate `thread_id` end-to-end,
esp. onto the `<channel>` notification so ask_remote echoes the origin topic) for solicited
paths; use the registry for port-selection + unsolicited.

## Blocked / intrinsic constraints (cannot be made id-specific)

- **Ghostty injection — BLOCKED.** `buildGhosttyKeystrokeScript` types into the _frontmost_
  window; Ghostty exposes no per-window/pane/tty/pid handle. Nothing to bind an id to. →
  Drop the Ghostty branch and route those users through tmux (the `ccd` alias already wraps
  claude in `tmux -L claude`); emit a clear "start under tmux" message rather than silent loss.
- **Cursor injection — partially BLOCKED.** id can pick the _window_ (folder→session 1:1) but
  never the _tab_; there's no per-tab scripting handle, and typing is focus-stealing +
  focus-guarded. Keep the `countSessionsInDir` "1 session per folder" gate — it's an intrinsic
  constraint, not a deletable fallback.

## Smaller edges to handle

- **Dead-pid GC.** Nothing garbage-collects a uuid-keyed entry when the pid dies. Keep a
  liveness reaper (`getRunningClaudeProcesses` stays) or dead entries accumulate and a
  reused pid/pane-id collides. tmux pane `%N` and ttys are _reused_ after close → registry
  must liveness-cross-check (pane exists AND owned by expected pid) before trusting a stored id.
- **`uuid8` collisions.** Keep the FULL uuid as the key; treat the 8-char display form as
  strictly non-authoritative (the webhook route accepts a human `session` string; users will
  type the displayed name).
- **`--session-id` × `--resume`/`--continue`.** Resume picks its own transcript id, so the
  pinned launch-uuid ≠ transcript sessionId; the "CC writes a different uuid than reported"
  quirk (the reason the newest-in-dir poll exists) must be verified against resume before the
  speculative-path/recovery machinery is removed.
- **Migration of existing on-disk state.** Records, the topic-ledger, and cron jobs persist
  `sessionName`/`sessionId` and have no `launchUuid`. Backfilling `launchUuid := existing
sessionId` risks importing an already-stale id; minting fresh leaves a gap until the next
  hook write. Needs a deliberate backfill plan.

## Bottom line for the plan

The strategy stands, with these bindings:

- **Scope fail-loud to launcher-born sessions**; keep lookup paths for Cursor/bare/offline (R1, R5).
- **Pin first, delete later**, gated on a soak (R2, R3).
- **Migrate ALL `sessionName` lookups to the uuid in one lockstep change** — do not half-do it; the `-2` token has wide reach.
- **Carry the prior uuid across `/clear`/resume/respawn** so topics survive (R4).
- **Split responsibilities**: registry = identity/port/unsolicited; origin-topic refactor = solicited destination (R6).
- **Drop Ghostty inject; keep Cursor's per-folder gate** (blocked cases).

Suggested plan split: **Plan A** = launcher pins `--session-id` + `PortFileData.launchUuid` + registry schema/writer (hook-fed, with pending-vs-miss states); **Plan B** = migrate consumers onto it (name→uuid lockstep, delete fallbacks) behind the soak; interleave with the existing origin-topic refactor for solicited paths. Reconcile against the WS-1/2/3-shipped identity-consolidation ledger rather than forking.
