# Remote tmux control — design spec (2026-07-09)

**Goal:** drive the `-L claude` tmux sessions from Telegram — see a session's live
screen, list all sessions, kill one, start a new one — via a button-driven panel.

## Commands

- **`/peek`** — capture-pane snapshot of the _current topic's_ session (session
  picker in General). Standalone shortcut for "show me this session's screen."
- **`/tmux`** — a button-driven control panel (no typed subcommands):
  - Renders the live session list; each session row carries `[🔍 Peek] [💀 Kill]`.
  - A `[➕ Start session]` button at the bottom.

## Targeting (correctness)

Every action resolves the target **launchUuid-first**, reusing the Task-2
`resolveTmuxTarget` primitive (pane + socket, sibling-safe) for peek, and the
launchUuid→session lookup for kill. **Inline-button callback data carries the
session's `launchUuid`** (stable), never the name — so a tap always hits the
session that was rendered, even if things churn between render and tap. In a
session topic the current session is the default target; in General the panel/
picker lists all.

## Behaviours

### `/peek` + `🔍 Peek`

- `tmux -S <socket> capture-pane -p -t <pane>` → the visible screen as text.
- Sent as an HTML `<pre>` block (visible screen ≈ 50 lines, within Telegram's
  4096-char limit; truncate defensively with a "…(truncated)" tail).
- A `🔄 Refresh` inline button re-captures in place (edits the message).
- No live auto-refresh, no scrollback paging in v1 (YAGNI).
- If the session has no resolvable pane (not under tmux / gone) → a clear
  "no tmux pane for this session" message, never a wrong-pane capture.

### `/tmux` list

- `tmux -L claude list-sessions` enriched with: cwd, attached/detached, and the
  Telegram topic each maps to (via the topic store, launchUuid-keyed).
- One row per session + its `[🔍 Peek] [💀 Kill]` buttons; `[➕ Start]` footer.

### `💀 Kill`

- Destructive → **Yes/No confirm** inline keyboard first.
- On confirm: `tmux -L claude kill-session -t <name>` (name resolved from the
  tapped launchUuid). Leaves the Telegram topic in place (the reaper / reconcile
  tidy it); we only kill the tmux session.

### `➕ Start session`

- **Default (this spec): spawn a Claude session**, reusing the existing `/new`
  spawn path (`spawn.ts`). Optional name is a follow-up. **Open decision:** could
  instead start a raw shell session (no Claude) — flip if desired.

## Security

All commands gated by `isAuthorized` (single allowed user). `/peek` returns
whatever is on screen — as sensitive as the terminal itself; that's acceptable
for a single-user personal bridge.

## Reuse / structure

- **`src/handlers/commands/tmux.ts`** (new) — `/peek` + `/tmux` handlers +
  panel/keyboard renderers + a pure `captureArgs(target)` / `killArgs(name)` /
  `listSessions()` seam for tests.
- Callbacks (`tmux:peek:<uuid>`, `tmux:kill:<uuid>`, `tmux:killyes:<uuid>`,
  `tmux:start`, `tmux:refresh:<uuid>`) dispatched in `callback.ts` (existing
  `set:*`/`gm:*` pattern).
- Reuse: `resolveTmuxTarget` (pane, launchUuid-safe), `buildTmuxSendArgs`-style
  argv builders, `showSessionPicker`, `busReply`, `isSessionTopic`, spawn path.
- tmux invocations go through a small `runTmux(argv)` wrapper (Bun.spawnSync)
  with the `-L claude` socket, mirroring the injection code.

## Testing

Pure builders (`captureArgs`, `killArgs`, list-row formatting, callback-data
encode/decode) unit-tested; the IO wrapper is a thin injectable seam. Panel
rendering asserted like the settings panel tests.

## Out of scope (v1)

Live auto-refreshing peek, scrollback paging, arbitrary `send-keys`/`/type`,
renaming, raw-shell start (pending the open decision above).
