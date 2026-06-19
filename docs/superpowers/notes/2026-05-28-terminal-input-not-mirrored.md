# Bug: native terminal input not mirrored to TG / Web

**Date:** 2026-05-28
**Status:** diagnosed, not fixed. Fresh session should pick this up.
**Severity:** medium — silent data loss on one of the three surfaces.

## Symptom

User types directly in a watched desktop CC terminal (e.g. `working ?`).
The terminal shows it and the assistant responds. But the user-typed line
**never appears in the Telegram topic or the Web UI** — only the
assistant's output does.

Reproduced live on the `kx_repo` session (topic 51544,
sessionId `1037e7b1-046b-43a7-bafd-6bb1e80ed103`,
dir `/Users/azaidi/Projects/Cursor/kx2/kx_repo`).

## The two-path model (key mental model)

TG/Web receive content from a watched desktop CC via **two independent
paths**:

1. **TCP relay-reply path** — the desktop CC's `reply` MCP tool (and the
   `sendWatchRelay` round-trip) push curated assistant output back over
   the relay TCP socket → `wireRelayDisplay` → MessageBus → TG.
   **This path is healthy.**

2. **JSONL watch tailer** — `SessionTailer` reads new lines from the
   session's `~/.claude/projects/<dir>/<sessionId>.jsonl` and emits
   TailEvents. `handleTailEvent` (in `src/handlers/watch/event-router.ts`)
   renders `text`/`tool`/`thinking`/`tool_result` to TG, and for `user`
   events emits a `user_message` on `globalEventBus` which
   `setupCrossPostSubscription` (`src/handlers/watch/cross-post.ts`)
   forwards to TG as `🖥 Terminal: …`. `bridgeTailToSse` feeds the same
   events to the Web SSE stream.

**Native terminal input has NO TCP path.** It exists only as a
`type:"user"` JSONL entry, so it can reach TG/Web _only_ via path 2. When
the tailer is silent, assistant replies still arrive (path 1) and mask the
fact that path 2 is dead — but terminal-typed user input silently
vanishes.

## Evidence

- `working ?` is in the watched JSONL as a clean entry: `type:"user"`,
  `message.role:"user"`, `message.content:"working ?"` (string),
  `isSidechain:false`, `userType:"external"`, `entrypoint:"cli"`. No
  channel-relay tag, no `originChat`. So CC recorded it correctly and the
  tailer's `parseLine` _should_ emit `{type:"user", content:"working ?"}`
  (tailer.ts ~line 369) → event-router `case "user"` (event-router.ts
  ~237) → `globalEventBus.emit(sessionName, {type:"user_message",
source:"terminal", content})` (line ~284) → cross-post forwards
  `🖥 Terminal: working ?`.
- The watch is correctly pinned to the **current** JSONL (`1037e7b1`),
  which was modified at 19:55 — the live file, not a stale one. (Drift was
  my first hypothesis; ruled out.)
- **But** the debug log (DEBUG=1, enabled in the launchd plist today) shows
  **zero tailer activity for topic 51544 between 19:45–20:00**, even though
  the JSONL was written at 19:55. Tailer typing events
  (`typing.touch via="text"|"tool"|"tool_result"|"usage"|"turn_end"`) for
  51544 stop after ~18:52 and never resume in the window.
- **Across the entire `bot.log`, there is not a single `🖥 Terminal:`
  cross-post — for any session, ever.** So the terminal-input → TG/Web
  path has effectively never worked in this deployment, not just during
  this episode.
- The assistant reply the user saw at 19:52 came via path 1 (TCP relay),
  which is why it appeared despite the dead tailer.

## Root cause (hypothesis, needs confirmation)

The JSONL tailer stalls and stops emitting events while the watch still
_looks_ active:

- `fs.watch` on macOS drops its handle when the watched file is
  replaced/truncated (CC rewrites the JSONL on compaction). `SessionTailer`
  has a `pollTimer` (`POLL_INTERVAL_MS`) backup that calls `readNew()` and
  re-arms `tryWatchFile()` — but evidently it isn't recovering here
  (offset desync after a rewrite? poll timer cleared? `readNew` reading
  past the rewrite boundary?).
- Because assistant output rides the independent TCP path, a dead tailer
  is invisible in normal use — only terminal-native user input exposes it.

Two distinct defects:

1. **Tailer doesn't reliably recover** when `fs.watch` drops or the file is
   rewritten. Investigate `src/sessions/tailer.ts`:
   - `start()` offset logic (starts at EOF; what happens when the file is
     truncated below the saved offset? `readNew` should detect
     `size < offset` and reset to 0 — verify it does).
   - `tryWatchFile()` re-arm path and whether `pollTimer` keeps calling
     `readNew()` after an fs.watch drop.
   - Whether `tailer.stop()` is being called unexpectedly (grep watch
     lifecycle: `cleanup.ts`, `session-builder.ts` drift restart,
     `idle-watchdog`).
2. **No fallback for terminal-native user input.** Even with a healthy
   tailer, this path is fragile. Consider a secondary signal (e.g. the
   relay/JSONL "last-prompt" entry — note CC also writes a
   `type:"last-prompt"` entry with `lastPrompt:"…"` which could be a more
   reliable trigger than the `type:"user"` line).

## Where to look

- `src/sessions/tailer.ts` — `parseLine` (user-entry handling ~278–369),
  `start()` / `readNew()` / `tryWatchFile()` offset + poll recovery.
- `src/handlers/watch/event-router.ts` — `handleTailEvent` `case "user"`
  (~237) and `bridgeTailToSse` `case "user"` (~57).
- `src/handlers/watch/cross-post.ts` — `setupCrossPostSubscription`
  forwarding (`🖥 Terminal:` label).
- `src/handlers/watch/session-builder.ts` — tailer construction + drift
  restart; `cleanup.ts` for teardown; `idle-watchdog.ts`.

## Repro / diagnostic recipe

1. DEBUG=1 is already set in `~/Library/LaunchAgents/com.azaidi.claude-bot.plist`.
2. In a watched CC terminal, type a short native message (`ping test`).
3. `grep "threadId=<topicId>" ~/Library/Logs/claude-mobile-bridge/bot.log
| grep -E "typing\.|user|Terminal"` — expect a `via="user"` typing
   event + a `🖥 Terminal:` cross-post. If absent, the tailer didn't emit.
4. Confirm the entry landed in the JSONL:
   `grep '"ping test"' ~/.claude/projects/<encoded-dir>/<sessionId>.jsonl`.
5. Cross-check tailer liveness: does `typing.touch via="text"` fire for
   that topic on the _next assistant turn_? If assistant events fire but
   `user` never does, the bug is in user-entry parsing/handling; if NO
   events fire at all, the tailer is fully stalled (poll/fs.watch
   recovery).

## Notes / context

- Project-dir encoding quirk: the registry `cwd` is `…/kx2/kx_repo`
  (underscore) but the on-disk project dir is
  `…/projects/-Users-…-kx2-kx-repo` (dash). `findSessionJsonlPath` scans
  all project dirs by sessionId so this didn't break the watch — but worth
  knowing if anything computes the JSONL path from cwd via
  `projectDir()` (tailer.ts ~550, which only replaces `/` and `.`, not `_`).
- DEBUG=1 was added to the launchd plist this session; consider reverting
  once this is fixed (log volume).
- Unrelated open item from this session: bot restart trips the boot-time
  topic reconcile that deletes-then-recreates cursor topics — FIXED on
  branch `feat/auto-watch-consistency` (commit `8c6531d`), not yet merged.
