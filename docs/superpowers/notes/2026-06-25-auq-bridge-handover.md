# Handover — AUQ bridge work & investigation (2026-06-25)

Session covered two things: (1) a shipped fix for AUQ cards not clearing in relay
mode, and (2) a deep live investigation into why native AskUserQuestion shows up
on Telegram as a read-only "Answer at the desktop" card with no buttons.

## Git state (all UNCOMMITTED, branch `feat/cursor-subscription`)

- `src/handlers/relay-bridge.ts` — modified (the relay bus-feed fix, below). **Tested, ready to commit.**
- `src/__tests__/relay-bridge-bus-feed.test.ts` — new test for the above. 2 tests, green.
- `hooks/claude-remote-auq-bridge.sh` — modified: **temporary diagnostic** `FIRED` log line. **REVERT before committing** (or keep a cleaned-up version as the "make silent bail loud" improvement — see Follow-ups).

Verification done: `bun run typecheck` clean; new test 2/2; full suite 268 fail vs **269 fail on clean-tree baseline** (pre-existing test-ordering pollution, our change adds none).

---

## 1. SHIPPED FIX — AUQ card stays blocked in relay mode

**Symptom (reported 2026-06-23):** "AUQ still blocks the TG channel even when the session is continuing on the terminal."

**Root cause:** The AUQ bridge auto-cancels on a local terminal answer via
`attachBusCancellation` (`src/handlers/auq-bridge.ts`), which subscribes to
`globalEventBus` for the `tool_result` of the AUQ's `toolUseId`. The bus is fed by
`bridgeTailToSse(...)`. Every **/watch**-mode tailer calls it (jsonl-tailer.ts:328,
session-builder.ts:159/297) — but the **relay**-mode tailer
(`relay-bridge.ts:90-95`) called only `handleTailEvent`, never `bridgeTailToSse`.
So in pure relay/topic mode the local answer never reached the bus → bridge never
cancelled → TG card stayed blocked.

**Fix:** extracted `makeRelayTailHandler(api, displayState, sessionName)` in
`relay-bridge.ts`; it now also calls `bridgeTailToSse(globalEventBus, sctx.sessionName, event)`
alongside `handleTailEvent`, mirroring the watch tailers. `relay_reply` still skipped
(TCP owns the final reply).

**Next step:** commit it (was awaiting user go-ahead).

---

## 2. INVESTIGATION — native AUQ shows "Answer at the desktop", no buttons

Triggered by user seeing a golden_facts AUQ card (kinetix-agents work) in Telegram
with no tappable buttons. Took several wrong turns (documented so they aren't
re-walked). **All hypotheses below were DISPROVEN except the last.**

### How the answerable path is supposed to work

1. Native `AskUserQuestion` fires → **PreToolUse hook** `~/.claude/hooks/claude-remote-auq-bridge.sh`
   (symlink → `claude-mobile-bridge/hooks/...`) runs.
2. Hook bails silently unless `RELAY_AUQ_SECRET` is set; else spawns detached
   `claude-remote-auq-worker.ts`.
3. Worker POSTs to bot `:WEB_PORT/api/auq-bridge` → route resolves session→topic →
   posts inline-keyboard card; long-polls for the answer.
4. On answer, worker injects it into the native picker via **`tmux send-keys`** to the
   session's pane (send-and-verify against `capture-pane`).
5. Independently, the bot's **tailer** always renders the read-only observe card
   (`formatAskUserQuestion`, `formatting.ts:659`, footer "Answer at the desktop.").
   This is separate from the buttons and always appears.

### Disproven hypotheses (with evidence)

- ❌ **"No topic for the session"** — topic store HAS kinetix-agents (root dir, sid `726a883c`).
- ❌ **Subdir cwd mismatch** — the route resolvers do exact-string dir match only
  (`findWatchByDir` registry.ts:58, `getTopicBySessionDir` topic-store.ts:141), and the
  old 404 log lines were deep subdirs — but those were STALE (log mtime was Jun 21) from
  earlier throwaway sessions. The actual live AUQ fired at **root** cwd.
- ❌ **Missing `RELAY_AUQ_SECRET`** — confirmed SET in both live claude processes (`ps eww`).
- ❌ **`--dangerously-skip-permissions` suppresses PreToolUse hooks** — claude-code-guide
  confirmed from official docs: it bypasses permission _prompts_, NOT hook dispatch; the
  hook command still runs.

### CONFIRMED root cause

**The kinetix session never invokes the AUQ hook at all.** Proven live:

- Firing a native AUQ in THIS (claude-mobile-bridge) session logs
  `auq-bridge-hook: FIRED secret=set tmux= cwd=…/claude-mobile-bridge`.
- `grep -c "FIRED.*kinetix-agents"` = **0**; no root-cwd POST anywhere in the worker log.
- Both sessions use `~/.claude` (no `CLAUDE_CONFIG_DIR` override); kinetix's project
  `settings.local.json` only has `permissions` (doesn't strip hooks).

So with no hook → no worker → no buttons → only the observe card.

**Leading (unconfirmed) reason WHY:** the kinetix session is on a **resumed** conversation
(`f6653e97…`, drifted from the registered `726a883c`). If it was originally started before
the AUQ hook was added to `settings.json` and `--resume` restored the old hook set rather
than reloading, it'd never pick up the hook. Settings mtime (Jun 23 22:19) predates the
process start (Jun 24 00:34), so a fresh launch _should_ load it.

**Pragmatic fix (not yet done):** kill the kinetix `claude` (pid was 37298) and relaunch
cleanly via the same `ccd` path the bridge session uses; a fresh launch loads the hook
(proven). Re-arm a monitor on `~/.claude/logs/auq-bridge-worker.log` and trigger one AUQ to
confirm `FIRED` now appears from kinetix. If it still doesn't fire after a clean restart,
escalate as a Claude Code hook-dispatch issue.

### Second latent issue (real, independent of tmux)

Even with the hook firing, these sessions are **not in tmux** (`tmux ls` → no server;
`TMUX` unset). The worker answers via `tmux send-keys`, so with no pane it returns
`skipped-no-pane` and can't deliver an answer. Answering native AUQ from TG requires
either tmux-wrapped sessions OR moving those flows to `ask_remote` (returns via MCP, no
pane needed).

---

## Follow-ups (recommended, by priority)

1. **Commit the relay bus-feed fix** (Section 1). Done & verified, just needs the go-ahead.
2. **Relaunch kinetix cleanly** to restore hook firing (Section 2 fix). User to drive.
3. **Make the silent hook bail loud (permanently).** Keep a cleaned version of the
   diagnostic: log when the hook bails for missing secret. Converts an invisible failure
   mode into a visible one. (`hooks/claude-remote-auq-bridge.sh`)
4. **Session-id drift in the topic store.** Topic store stuck on `726a883c` while the live
   session is `f6653e97`. When the relay/watch follows a session across a new conversation
   id, update the stored sid so the bridge route's id-resolution keeps working.
5. **Nearest-ancestor dir resolution** in `findWatchByDir`/`getTopicBySessionDir` (+ the
   route). Walk up to the nearest registered ancestor dir so genuine subdir sessions
   resolve to the project topic. Exact `session_id` still wins first (sibling-safe per
   bdae315); nearest ancestor breaks ties. TDD. NOT the cause of the current symptom, but
   real robustness. (Was "Fix A".)
6. **Observe-card UX.** The read-only "Answer at the desktop." card always renders even
   when answerable buttons exist — misleading. Suppress/relabel it when a bridge is active
   for that toolUseId.

---

## Other discussions this session (context, no code)

- **Relay outbound "single stream" (Option B).** The dup/asymmetry pain comes from two
  outbound paths (TCP relay reply via `wireRelayDisplay` + JSONL tailer). Collapsing to the
  tailer is a medium refactor (parse files/pdf/edit/react off the JSONL tool_use input,
  swap `waitForReply` to `turn_end`, drop the `relay_reply` skip, honor `originChat` for
  routing, replace the request_id security gate). **B-lite** (just also emit `relay_reply`
  to `globalEventBus` for web symmetry, keep TCP for TG) is a ~1-line low-risk win.
- **Competitor reviews** (verdict: none attach to a live desktop session w/ handoff — that's
  our moat): slopus/happy (native apps, E2E, voice, 1-keypress handoff — steal: handoff UX,
  notification taxonomy); RichardAtCT/claude-code-telegram (bot-owned SDK sessions — steal:
  per-user spend caps+audit, session export, /repo workspace switch); gergomiklos/heyagent
  (thin local — steal: QR pairing, sleep-prevention); linuz90/claude-telegram-bot (Agent
  SDK spawn — note: Agent SDK for our spawn path); **pavel-molyanov/telegram-ai-agent** (the
  one with a real idea: **`/tui` remote tmux control** — buttons for Enter/Esc/arrows/digits
  to drive the actual TUI; general answer to /clear, permission prompts, native AUQ as a
  fallback).
- **Out of scope:** an Elasticsearch verification message for kinetix Tasks 7–8 bled into
  this session. Recommendation given (pin `elasticsearch~=7.17` to match the 7.17.5 server,
  fix `.env` URL to `http://10.20.0.41:9200`, add the dep, don't touch `kinetix-vector-index`),
  but it belongs to the kinetix repo, not this one.

## Key files

- `src/handlers/relay-bridge.ts` — relay tailer + the fix
- `src/handlers/auq-bridge.ts` — orchestrator, `attachBusCancellation`
- `src/web/routes/auq-bridge.ts` — the route that 404s ("no watch or topic for cwd")
- `src/handlers/watch/event-router.ts` — `bridgeTailToSse`, `handleTailEvent`, observe-card render
- `hooks/claude-remote-auq-bridge.sh` + `hooks/claude-remote-auq-worker.ts` — the PreToolUse hook + worker
- `~/.claude/logs/auq-bridge-worker.log` — worker/hook diagnostics
- `~/.claude-mobile-bridge/topics.json` — topic store (the stale-sid bug)
