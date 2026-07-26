# Interactive `/tui` panel, send guard, and modal watchdog

Date: 2026-07-10
Status: approved design, not yet implemented

## Problem

Claude Code's TUI blocks keyboard input behind interactive dialogs — trust
prompts, Bash-permission prompts, sensitive-file-edit confirmations, `/usage`,
`/mcp`, `/login`, `/config`, `/model`, `/status`. Two consequences:

1. **A blocked session is invisible from Telegram.** `/peek` renders a read-only
   snapshot; there is no way to answer the dialog from a phone. The session
   stalls until the user reaches a desktop.

2. **`sendKeysToSession` can silently confirm a dialog.** `buildTmuxSendArgs`
   (`src/handlers/commands/terminal-inject.ts`) emits `send-keys -l <text>`
   followed by an unconditional `send-keys Enter`. When a modal is up, the
   literal text is a **no-op** — the characters never reach the input buffer —
   and the bare `Enter` acts as "confirm the highlighted item". That can approve
   a shell command, edit a sensitive file, or switch the model. `/clear`,
   `/compact`, and `/context` are registered bot commands (`src/bot.ts:307-309`),
   so this is reachable from Telegram. It is a race — a modal must be open at the
   moment of injection — but the failure is silent approval of an unseen command.

Both behaviours were verified against Claude Code 2.1.117 by the
`telegram-ai-agent` project (`heyzgj`… see Prior Art), whose `modal_detect.py`
documents the `send-keys -l` no-op and the `Enter`-confirms-item hazard.

## Scope

One change, three components, sharing one pure core:

1. Interactive key panel attached to `/peek`'s existing capture message.
2. A send guard on `sendKeysToSession` that refuses to press Enter unless the
   text demonstrably landed in the input bar.
3. A watchdog that detects a session blocked on a dialog and pushes a Telegram
   alert with the key panel attached.

Out of scope: Codex support, voice input, bracketed-paste delivery for long
prompts, `/resume` listing.

## Prior art

`https://github.com/pavel-molyanov/telegram-ai-agent` — `src/telegram_bot/core/tui/`.
We copy its keyboard layout, its 21-action key map, its two-gate modal detector,
its 500 ms settle, and its dedup-on-pane-text watchdog. We deliberately diverge
in two places (see Divergences).

## Approach

New `src/tmux/` module: a pure, testable core with a single IO seam. Chosen over
extending `tmux.ts` in place (already ~500 lines; the detector would end up
untestable behind `Bun.spawnSync`) and over `src/sessions/` (that module is about
identity; this is about terminal state).

The detector must be a pure function because its contract is _fail safe against
modals we have never seen_. That is only demonstrable by feeding fixture panes
through a function with no side effects.

## Components

### `src/tmux/exec.ts` — the IO seam

Owns `runTmux(argv)` (the ENOENT-safe `Bun.spawnSync` wrapper currently private
to `tmux.ts`), `isNoServer(stderr)`, `capturePane(target)`, and socket
resolution.

Reconciles an existing inconsistency: `tmux.ts` hardcodes the `-L claude` socket
while `terminal-inject.ts` reads `tmuxSocket` from the port file. `TmuxTarget`
becomes `{ pane, socket }` everywhere, with `socket` defaulting to the `-L claude`
name when a port file carries none. Both callers route through this module, so
"which tmux server" is decided in one place. The guard requires both files to
capture the same pane, so this cannot be routed around.

`capturePane` returns `""` on any failure: non-zero exit, missing binary, or a
5 s timeout. The timeout exists because a wedged tmux server would otherwise hang
every request behind the capture. Callers MUST read `""` as _unknown state_ and
never press Enter on it.

### `src/tmux/modal-detect.ts` — pure

Ported from `modal_detect.py`. Two gates:

- **Gate A — footer token.** A capital-`E` dismiss token
  (`Esc to cancel|clear|exit|dismiss|close`, or `Enter to confirm`) within the
  last 5 non-blank lines. Claude's idle and thinking states render lowercase
  `esc to interrupt`; the case difference is the entire discriminator. Scanning
  only the last 5 lines avoids false positives from scrollback that merely
  _quotes_ "Esc to cancel".

- **Gate B — structural sandwich.** The idle input bar is
  `─────` / `❯ <text>` / `─────`, requiring a `─{10,}` separator both above and
  below the `❯`. Modals contain `❯` as a menu cursor (`❯ 1. Yes`) but lack the
  frame.

Exports:

- `stripBlankTail(pane)` — tmux nondeterministically pads panes to their
  configured height or trims them. Without this, a last-N-lines scan counts from
  the physical pane bottom and a modal footer slips out of the window. Verified
  in prior art: the same TUI state yielded opposite verdicts at pane heights 33
  and 20.
- `isModalPresent(pane)` — **Gate A alone.** Used by the watchdog. Gate B returns
  "no bar" on any transient render (Claude startup, mid-tick refresh, empty
  capture), and a watchdog gated on it would alert constantly. Returns `false` on
  an empty pane.
- `promptVisibleInPane(before, after, prompt)` — **both gates**, plus
  whitespace-collapse normalization. Used by the send guard.

Normalization: Claude prepends a 2-space indent to input-bar continuation lines
and replaces a space with a newline on word-wrap. Collapsing all whitespace runs
to a single space in both the prompt head (first 30 chars) and the extracted bar
content makes the substring match invariant to both transforms.

Three delivery signals, in order:

1. Normalized-head substring match (primary).
2. `[Pasted text #N]` / `[Pasted Content N chars]` placeholder, accepted only
   when its **count increased** versus `before` — Claude collapses long payloads
   and the head never renders as text.
3. First-line-only substring, guarded by a 10-char minimum so short first lines
   (`ok`) cannot collide with unrelated pane content.

Two false-positive guards: `before` subtraction (a head already in the bar from a
prior send is carry-over, not delivery) and the placeholder count-delta.

### `src/tmux/keys.ts` — pure

The 21-action map, the keyboard builder, and the callback parser.

| action | argv              |     | action | argv  |
| ------ | ----------------- | --- | ------ | ----- |
| `up`   | `Up`              |     | `cC`   | `C-c` |
| `dn`   | `Down`            |     | `cU`   | `C-u` |
| `lt`   | `Left`            |     | `cO`   | `C-o` |
| `rt`   | `Right`           |     | `cR`   | `C-r` |
| `ent`  | `Enter`           |     | `cT`   | `C-t` |
| `bsp`  | `BSpace`          |     | `num0` | `0`   |
| `esc`  | `Escape`          |     | `num1` | `1`   |
| `esc2` | `Escape` `Escape` |     | `num2` | `2`   |
| `tab`  | `Tab`             |     | `num3` | `3`   |
| `btab` | `BTab`            |     |        |       |

Plus `refresh` and `close`, which emit no keys.

Keyboard layout (4 rows), copied verbatim:

```
row 1:  ⬆️  ⬇️  ⬅️  ➡️
row 2:  ↩️  ⌫  Esc  Esc 2  Tab  ⇧Tab
row 3:  1  2  3  0
row 4:  ⌃C  ⌃U  ⌃O  ⌃R  ⌃T  🔄  Close
```

`parseTuiCallback(data)` parses `tui:<action>:<launchUuid>` and returns `null` on
an unknown action rather than passing an arbitrary string to `send-keys`.
Worst-case payload is `tui:` + 5 + `:` + 36 = 46 bytes, under Telegram's 64.

### Consumers

**`tmux.ts`** — `/peek` swaps its lone 🔄 Refresh button for `buildTuiKeyboard`.
`/tmux`'s 🔍 button inherits it, since both call `sendCapture`. A new `tui:*`
callback branch handles taps. No new command.

**`terminal-inject.ts`** — `sendKeysToSession` becomes:
capture `before` → `send-keys -l <text>` → settle 500 ms → capture `after` →
`promptVisibleInPane` → Enter only on `true`.

**`src/tmux/watchdog.ts`** — own timer at 15 s, independent of `watcher.ts`'s
60 s poll (too slow for "your session is blocked").

## Data flow

### Panel tap

Tap arrives as `tui:<action>:<launchUuid>`. The handler re-resolves the
launchUuid to its **current** pane via the existing sibling-safe
`listTmuxRows()` join, answering "Session gone." if it has vanished. Then
`send-keys -t <pane> <argv…>`, sleep 500 ms, re-capture, `editMessageText` with
the fresh pane and the same keyboard.

`refresh` skips the send. `close` deletes the message.

Because every tap re-resolves, a keyboard left over from a killed-and-restarted
session cannot drive the wrong pane: it targets a `launchUuid`, not a pane id.

### Send guard

Applies to `/clear`, `/compact`, `/context`, and every future
`sendKeysToSession` caller.

The design is **empirical, not predictive**. We never try to decide in advance
whether a modal is up; we observe whether our text arrived. `send-keys -l` into a
modal is already a no-op, so the probe is harmless in the bad case. A regex
preflight on "Esc to cancel" would break the day Claude ships a modal with new
wording; this does not.

On `promptVisibleInPane === false`, send **nothing further** and return
`{ ok: false, reason: "blocked" }`. The command surfaces the pane plus the key
panel, so the user can see the dialog and answer it in place.

### Watchdog

Each 15 s tick: `listTmuxRows()`, capture each row, `isModalPresent(pane)`. On
`true`, resolve `getTopicByLaunchUuid` and push an alert to that topic with the
key panel attached.

Dedup map `launchUuid → last alerted pane text`. An unchanged pane on the next
tick is a no-op. The entry is cleared when `isModalPresent` returns false, so a
later second modal re-alerts.

## Error handling

**Governing rule: when pane state is unknown, never press Enter.** An empty
capture means unknown. The guard reports `blocked`; failing closed costs a retry,
failing open silently approves a command.

`isModalPresent("")` is `false`, so an unreadable pane never _creates_ an alert
either. Both directions fail quiet.

| Case                                  | Behaviour                                                                                                                                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session dies between render and tap   | `answerCallbackQuery("Session gone.")`, keyboard left in place                                                                                                                                                                               |
| Pane unchanged after keypress         | Telegram's `message is not modified` swallowed, logged at debug. Not an error — the TUI did not redraw                                                                                                                                       |
| `send-keys` fails (pane gone mid-tap) | Surface stderr in the callback answer; do not edit the message, the on-screen pane is still accurate                                                                                                                                         |
| Watchdog tick throws                  | try/catch per tick **and** per row; one unreadable pane must not kill the timer or skip other sessions. Log a warning — a silently dead watchdog is the worst failure                                                                        |
| Concurrent taps                       | Serialize per-launchUuid with an in-flight set. A tap while one is pending gets `answerCallbackQuery("busy")` rather than queueing: queued keystrokes into a TUI whose state has moved on is exactly how the wrong dialog item gets approved |
| Unauthorized user                     | Existing `isAuthorized` check, on both command and callback paths, before any tmux call                                                                                                                                                      |

`⌃C` is not special-cased; it sends `C-c` like any other key. Interrupting a turn
is recoverable and the user is looking at the pane when they press it.

### Why 500 ms settle

Measured in prior art on Claude Code 2.1.118 (pane 200x50): fast redraws
(BSpace, opening a menu) complete in 15–20 ms; slower transitions (Escape
closing a menu, modal dismissal after digit-select) reach 80 ms; mid-thinking
redraws land on the next render tick, ~200 ms. Their original 50 ms missed every
slow case and surfaced as a user complaint. 500 ms is "definitely enough" and
still below the ~600 ms where chat UI feels sluggish.

### Residual race

The settle-and-recapture guard is not airtight; one narrow TOCTOU window
remains, by design:

- A modal that pops **during** the 500 ms settle (after the text lands,
  before the re-capture) **is caught**: the after-pane has no framed input
  bar, `promptVisibleInPane` returns `false`, and we refuse. Verified by
  fixture tests.
- A modal that pops **after** the re-capture but **before** the `Enter`
  send-keys reaches tmux is **not detectable** by any capture-based design.
  That window is one send-keys round-trip (single-digit ms) versus the 500 ms
  settle — small enough to be an accepted, inherent limitation, not a bug.
  Do not describe the guard as airtight; it closes the wide window, not the
  narrow one.

## Divergences from prior art

1. **No `epoch` in callback data.** They embed the first 8 hex of the session id
   to reject stale keyboards. We re-resolve `launchUuid` → current pane on every
   tap and answer "Session gone." — a strictly stronger guard, since it also
   survives a session id change from `/clear`.

2. **Target by pane id, not session name.** `listTmuxRows()` joins port files,
   the registry, and `list-panes` on the `-L claude` socket. This is
   sibling-safe: two sessions in one folder resolve to distinct panes.

## Testing

**Fixtures MUST be captured from a live Claude, not hand-authored.** A written
fixture encodes our belief about how a permission dialog renders; the guard would
then pass its tests and fail on the real thing — the exact bug this work exists
to prevent. During implementation, run Claude under tmux, trigger each state, and
`capture-pane -p > fixture.txt`.

Required fixture states: idle input bar, mid-thinking, Bash-permission dialog,
trust dialog, `/model`, `/usage`, and a pane whose **scrollback quotes** "Esc to
cancel" ~5 lines from the bottom.

`modal-detect`:

- Gate A fires on every captured modal footer; does not fire on idle or thinking.
- Gate A does not fire on the scrollback-quote fixture.
- Gate B rejects a modal whose `❯` is a menu cursor despite no frame.
- `promptVisibleInPane` returns `false` for every captured modal against any
  prompt. **This is the security-critical assertion** — it makes "Enter never
  lands in a dialog" a property rather than a hope.
- Delivery `true` on the idle bar; `false` on carry-over (head already in
  `before`); `true` on a placeholder count increase; `false` on a stale
  placeholder.
- A word-wrapped, 2-space-indented prompt still matches.
- `stripBlankTail` yields an identical verdict for one TUI state at two pane
  heights.

`keys`: all 21 actions map to argv; `esc2` yields two `Escape`s; unknown actions
return `null`; `buildTuiKeyboard` → `parseTuiCallback` round-trips; callback data
stays under 64 bytes with a full 36-char launchUuid.

`terminal-inject` guard: with a fake capture returning a modal fixture, assert
**no Enter argv is ever emitted** and the result is `blocked`; assert Enter _is_
emitted when the capture shows the prompt landed; assert an empty capture is
treated as blocked.

`watchdog`: fake `listTmuxRows` + captures. Alerts once on a modal pane; no
second alert on an unchanged pane; re-alerts after idle→modal; one throwing row
does not stop the others.

Existing `src/__tests__/tmux-command.test.ts` covers `parseTmuxPanes` and
`fitEscapedCapture` and must stay green through the `exec.ts` extraction.

## Phasing

1. `exec.ts` extraction (behaviour-preserving; existing tests stay green).
2. `modal-detect.ts` + captured fixtures + tests.
3. `keys.ts` + tests.
4. `/peek` panel + `tui:*` callback.
5. Send guard on `sendKeysToSession`.
6. Watchdog.

Phases 1–3 land the pure core. Phase 5 is the security fix and depends on 1–2.
Phase 6 depends on 2–3.
