# Permission Relay Design

**Date:** 2026-07-17
**Status:** Implemented and verified end-to-end (2026-07-17)
**Supersedes:** `2026-07-16-bash-permission-bridge-design.md` (branch
`feat/bash-permission-bridge`, abandoned at `1f05947`)

## Problem

When a Claude Code session hits a **tool-permission prompt** — the inline overlay
"Bash wants to run: `rm -rf …` / Allow once / Deny" — **nothing shows on
Telegram**. The prompt is an ephemeral TUI overlay that is never written to the
session JSONL, so the transcript tailer driving every other card cannot see it.
Work stalls silently until someone returns to the desktop.

## Requirement (the bar, verbatim)

> "it doesnt sound good. we need it seemless - desktop should be identicla to
> today and the telegram should show the pormpt AS WELL. should be able to answer
> from either"

Three things, all load-bearing:

1. The desktop prompt renders exactly as it does today.
2. The prompt also appears on Telegram.
3. Either surface can answer it; first to answer wins.

## The determining fact

**Claude Code ships this as a first-class channel capability.** A two-way channel
that declares `claude/channel/permission` receives every tool-approval prompt in
parallel with the local dialog. Per the
[channels reference](https://code.claude.com/docs/en/channels-reference#relay-permission-prompts):

> When Claude calls a tool that needs approval, the local terminal dialog opens
> and the session waits. A two-way channel can opt in to receive the same prompt
> in parallel and relay it to you on another device. Both stay live: you can
> answer in the terminal or on your phone, and Claude Code applies whichever
> answer arrives first and closes the other.

That is requirements 1, 2 and 3, delivered by the platform. We write no
arbitration logic, and we never touch the terminal.

We already qualify:

| Prerequisite                           | Status                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| Is a channel                           | ✅ `server.ts:604` declares `'claude/channel': {}`                                  |
| Registers past the preview allowlist   | ✅ `--dangerously-load-development-channels server:channel-relay` (`config.ts:148`) |
| Client ≥ v2.1.211 (field sanitisation) | ✅ v2.1.212                                                                         |
| Authenticates the **sender**           | ✅ see [Sender gating](#sender-gating-the-hard-prerequisite)                        |

## Mechanism

```
Claude calls a tool needing approval
   ├─ local dialog opens at the desktop, unchanged           ◄── requirement 1
   └─ notifications/claude/channel/permission_request → relay
        └─ ask_remote_request-style frame → bot → card in the session's topic  ◄── requirement 2

   user taps Allow/Deny on the phone
        └─ frame → relay → notifications/claude/channel/permission
             └─ Claude Code applies the first answer, closes the other  ◄── requirement 3
```

**Out** — `notifications/claude/channel/permission_request`, params:

| Field           | Notes                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `request_id`    | Five lowercase letters from `a`-`z` **minus `l`**. Echo it back verbatim. Not shown in the local dialog.              |
| `tool_name`     | `Bash`, `Write`, `Edit`, …                                                                                            |
| `description`   | Summary of the call, **never the command**. May be the bare constant `Run shell command` with zero detail. Untrusted. |
| `input_preview` | The tool's args as JSON-shaped text — for Bash, the command. Untrusted.                                               |

**Back** — `notifications/claude/channel/permission` with `{request_id, behavior}`,
`behavior ∈ {'allow','deny'}`. Neither verdict affects future calls.

**Observed live** (2026-07-17, spike: capability declared + handler logging only,
in an interactive bypass session; `rm -rf` → hook `ask` → dialog opened):

```json
{
  "request_id": "cmssh",
  "tool_name": "Bash",
  "description": "Delete the victim.txt test fixture",
  "input_preview": "{ \"command\": \"rm -rf /private/tmp/…/victim.txt\", \"description\": \"Delete the victim.txt test fixture\" }"
}
```

The dialog stayed live on the desktop throughout, and was then answered there
normally. This settles the one link that could have killed the design: the
notification **does** fire for a hook-originated `ask` under
`--dangerously-skip-permissions`. Note `description` arrived as the model's real
description rather than the `Run shell command` constant — do not rely on that;
`input_preview` is the field that carries the command.

Because the relay runs _inside_ the session, it already knows its own
`sessionId` — topic routing is free. The abandoned hook design had to
reverse-engineer this and frequently failed (`no topic` in
`~/.claude/logs/permission-bridge.log`).

### Rendering

Render `input_preview`, not just `description`: for a Bash call `description` can
be `Run shell command` and carry no command detail at all. The card must show
what is actually about to run.

Both fields are **untrusted** — they originate from the model. v2.1.211+ clients
sanitise them (neutralise direction-override/invisible characters, quote and
angle-bracket lookalikes, fold whitespace, elide past 3,500 code points keeping
head and tail). We still escape on render; sanitisation is not authorisation.

### Scope

All relayed tools (`Bash`, `Write`, `Edit`, …) — there is no per-tool cost, so
gating on tool name would be arbitrary. Project-trust and MCP-server-consent
dialogs do **not** relay; those stay desktop-only and are out of scope by
construction.

### Card

Matches the AUQ card's look, but renders its own rather than calling
`relay-ask.ts`'s `sendBridgeQuestion` / `editBridgeCardCancelled`: those are
built around AUQ's question/options shape and its `bridge:*` registry, so
reusing them would couple this feature to the exact code the standing constraint
says not to touch. `perm:*` sits beside `bridge:*` and `askremote:*` instead.

Standing constraint: **purely additive**. The existing `ask_remote` / AUQ paths
must not change — they work for existing users.

Card states:

- live → `✅ Allow once` / `🚫 Deny`
- tapped → `✅ Allow sent` / `🚫 Deny sent`
- send failed → `⚠️ Couldn't deliver — answer at the desktop`
- session gone → `✖ Session disconnected`

**"Sent", not "allowed" — the card may not claim an outcome.** Nothing in this
path acks. A verdict is a fire-and-forget notification, and Claude Code silently
drops one for a prompt that is already resolved. That is not an edge case: it is
the _common_ case, because answering at the desktop leaves the card standing —
nothing tells the bot it happened. So a tap only ever proves "we sent it".

An earlier revision of this document specified a `🖥️ Answered at the desktop`
state. **No such state is implementable**: there is no signal for a desktop
answer, which is the whole reason the card must not assert one. Claiming "🚫
Denied" for an `rm -rf` that had already run would be a worse lie than the
abandoned design's, and review found the code doing exactly that.

**Routing: the session's topic only.** No General fallback. The relay knows its
own `sessionId`, so a topic is the natural home; a session with no topic gets no
card. A permission card in General would be ambiguous about which session it
belongs to — and this card approves shell commands, so ambiguity is the one thing
it must not have.

**Lifetime: leave the card live.** No expiry timer. The desktop dialog waits
indefinitely, so the card should match it: a card that self-retires while the
prompt is still open would reproduce the exact lie the abandoned design shipped
(card says expired, terminal still blocked). A late verdict for an
already-answered prompt is dropped by Claude Code, so an old button is harmless
— given the safety note below.

**`request_id` is unique per session, NOT globally — key cards by a bot-minted
token.** Five letters from a 25-letter alphabet, drawn independently by each
session. Keying the bot's pending-card map by it (as the first implementation
did) meant a second session drawing the same id silently overwrote the first
entry, and a tap on session A's card sent the verdict to session B's client:
**the user approves the command they are looking at and a different, unseen one
runs.** Review caught this with a working repro. Cards are therefore keyed by a
random per-card token which carries its own client, so a tap can only ever
answer the prompt whose card it is on. This is also what makes "leave the card
live" safe: stale cards accumulate (desktop answers leave them behind), so
collisions are birthday-scale over a session's lifetime, not per-pair.

## Sender gating (the hard prerequisite)

The docs are explicit:

> Only declare the capability if your channel authenticates the sender, because
> anyone who can reply through your channel can approve or deny tool use in your
> session.

Verified 2026-07-17:

- **`bot.ts:172`** — global `bot.use` gating `ctx.from?.id` (the **sender**, not
  the chat) via `isAuthorized(userId, ALLOWED_USERS)`. Registered ahead of every
  handler (280+), so it covers callback queries (taps) as well as messages.
  Unauthorised updates are dropped silently.
- **`security.ts isAuthorized`** — fails closed: false on missing id, false on an
  empty allowlist.
- **`config.ts:415`** — `process.exit(1)` at startup without
  `TELEGRAM_ALLOWED_USERS`. The bot cannot run ungated.
- **`server.ts:466`** — `tcpServer.listen(0, "127.0.0.1")`; the relay is
  loopback-only on an ephemeral port published via the port file.

**Accepted, not fixed:** once a request reaches the relay's local port, the
request id is the only routing token (`server.ts:520` already notes this for
`ask_remote`). Any local process could post a verdict — but a local process has
strictly worse options available, and this matches the existing trust model
rather than widening it.

## Bypass stays: hooks are the gate

`config.ts:148` launches every `/new` desktop session with
`--dangerously-skip-permissions`. That flag **stays**, and it is not in tension
with this feature — it is what makes it sharp.

**A `PreToolUse` hook's `permissionDecision: "ask"` is NOT bypassed by
`--dangerously-skip-permissions`.** Verified 2026-07-17 against v2.1.212 three
ways, strongest first:

1. **Live, in the real configuration.** An interactive cmux session launched with
   `--dangerously-skip-permissions --dangerously-load-development-channels
server:channel-relay` — identical to what `/new` spawns — renders a full
   permission dialog for `rm -rf`:

   ```
   Hook PreToolUse:Bash requires confirmation for this command:
   rm -rf detected — are you sure?

    Do you want to proceed?
    ❯ 1. Yes
      2. No
   ```

   Captured via `cmux read-screen`. This is the case that matters: bypass on,
   relay loaded, real dialog.

2. **Controlled `-p` runs** (both `-p --dangerously-skip-permissions`):

   | Command                | Hook    | Result                                         |
   | ---------------------- | ------- | ---------------------------------------------- |
   | `rm control_plain.txt` | silent  | deleted, no prompt — bypass genuinely active   |
   | `rm -rf test_rmrf.txt` | `"ask"` | **blocked**: `rm -rf detected — are you sure?` |

3. **In the v2.1.212 source**: when a hook returns `ask`, `hookAskFloor` is
   threaded into the pipeline and the mode-based auto-allow branch preserves
   `behavior:"ask"` instead of rewriting it to `allow`; where no ask-rule matches,
   the hook's decision is returned directly without consulting the mode at all. The
   SDK's own guidance agrees — _"bypassPermissions auto-approves every tool call
   (except explicit deny rules) before the callback is consulted. To gate every tool
   call, use a PreToolUse hook instead."_

So the intended shape, which the operator already runs:

- **bypass** removes the routine per-tool approvals a headless session would
  stall on (the flag's original purpose — still served).
- **user hooks** (`~/.claude/hooks/block-destructive-git.sh`) `deny` the
  catastrophic (`git push --force`, `reset --hard`) and `ask` the dangerous
  (`rm -rf`, `DROP TABLE`).
- **this relay** carries exactly those asks — a small, high-signal set — to the
  phone.

That is the whole value: the prompts that survive bypass are, by construction,
the ones actually worth waking someone for. No blanket-prompt regression, no
behaviour change for existing users, no new setting.

**Caveat — interactive only.** In non-interactive `-p` mode a surviving `ask`
cannot be answered and simply blocks the tool (evidence 2 above). Bot `/new`
sessions are interactive TUIs, so the ask opens a real dialog (evidence 1) — that
dialog is what relays.

An earlier draft of this document claimed the opposite: that `/new` sessions
"never prompt, so relay is a no-op for them", and that the payoff was dropping
the bypass flag. Both were wrong, from reasoning about the flag's name instead of
watching it run. The operator had been watching these dialogs appear in their
terminal the whole time.

## Components

| Component                         | Change                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/mcp/channel-relay/server.ts` | Declare `'claude/channel/permission': {}`; `permission_request` handler; verdict emitter |
| `src/handlers/…` (new)            | Card post/retire under `perm:*`, reusing the AUQ renderer                                |
| `src/handlers/callback.ts`        | `perm:<id>:<allow\|deny>` branch (additive)                                              |

No hook. No worker. No `read-screen`. No fingerprinting. No keystroke injection.
Nothing registered in `~/.claude/settings.json`.

## Designs we tried and killed

**Rev 1 — blocking `PermissionRequest` hook returns the decision.** Premise: the
native dialog renders in parallel and the hook can long-poll, first-to-resolve
wins. **False for hooks** — verified in the v2.1.212 source, a `PermissionRequest`
hook is a _sequential gatekeeper_:

```js
if (awaitAutomatedChecksBeforeDialog) {       // true whenever hooks are configured
  let decision = await runPermissionRequestHooks(...)
  if (decision) { apply(decision); return }   // decided → native prompt NEVER shown
}
return showNativeDialog(...)                  // only reached when the hook declines
```

A hook that blocks shows the desktop nothing, violating requirement 1.

**Rev 2 — AFK toggle.** Gate bridging on an "I'm away" setting. Killed by the
requirement: a manual toggle with two forget-modes never delivers "both surfaces
live, answer from either".

**Rev 3 — instant hook + detached worker + verified injection.** Hook exits
immediately (desktop renders normally), a detached worker fingerprints the modal
via `cmux read-screen`, posts the card, and types the answer back into the TUI.
It worked, but it was an elaborate reconstruction of a feature that already
existed: ~700 lines, a keystroke injector whose worst failure mode was approving
a command the user never saw, plus global hook registration. Abandoned at
`1f05947`.

**The lesson — the actual root cause.** Rev 1's premise ("parallel dialog,
first-to-resolve wins") was _correct_; it was tested against the wrong mechanism.
Hooks are sequential; **channels are parallel by design**. One true fact about
hooks was generalised into "the platform cannot do this", and three designs were
built on that generalisation without ever checking the feature docs for a
first-class API. Check for the supported mechanism before reconstructing it.

## Known gaps

- **Research preview.** Channels — and this capability — are preview surface; the
  contract may change.
- **Relay has no hot-reload.** Editing `src/mcp/channel-relay/*` needs a Claude
  session restart; only the bot runs under `bun --watch`. Testing is
  restart-gated.
- **Both directions verified live** (2026-07-17), **single-session**: a `/new`
  session's `rm -rf` opened the desktop dialog and posted a 🔐 card to its topic;
  tapping Allow closed the dialog and the command ran. Note what that did _not_
  cover: the cross-session collision above was live-green and still broken. One
  happy-path run is not evidence of correctness.
- **Multi-session is covered by tests, not by a live run.** Two concurrent
  sessions with colliding `request_id`s are exercised in
  `permission-relay.test.ts`; nobody has driven two real sessions at once.
- **No opt-out.** The capability is declared unconditionally, so a user _not_
  running `--dangerously-skip-permissions` gets a card for every Bash/Write/Edit
  approval. Fine for the operator (bypass + `ask` hooks = a small, high-signal
  set — see above), potentially noisy for anyone else. If it bites, gate it on a
  `BridgeSettings` toggle the way `cursorEnabled` / `watchImages` are.
- **Sessions with no `ask` hooks see nothing.** Under bypass, the relay's value is
  exactly the operator's hook policy. A user without `ask` hooks gets an
  installed feature that never fires — worth saying out loud in any user-facing
  docs.
