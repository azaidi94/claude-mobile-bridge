# AskUserQuestion Remote Bridge Design

**Date:** 2026-05-11
**Status:** Pending approval
**Branch:** `feat/auq-remote-bridge`

## Problem

The bot's purpose is to keep the user productive from Telegram and the Web UI while the desktop is unattended. The JSONL-tailing architecture surfaces text streams, tool calls, and tool results to TG/Web in real time — but Claude Code's built-in `AskUserQuestion` (AUQ) tool is a hard stop:

- CC holds the AUQ-bearing assistant message in memory and does NOT flush it to JSONL until the user answers the picker at the local TUI.
- The bot's tailer can only read what's on disk, so an unanswered AUQ is invisible to TG and Web UI.
- Every AUQ a project (or a skill — e.g. `superpowers:brainstorming`) triggers becomes a brick wall: the user must walk back to the terminal to unblock.

Empirically confirmed on 2026-05-10: saas-builder's CC sat blocked on an AUQ for 15+ minutes with the JSONL untouched; `lsof` showed no `claude` process holding it for writing.

This is **not** a bug in the bot or in the event-bus refactor. It's a product behavior of CC: the `AskUserQuestion` tool resolves synchronously at the local TUI, and CC commits the turn to JSONL only after the resolution.

## Constraints & enabling context

1. **CC v2.1.85 (2026-03-26)** introduced: _"PreToolUse hooks can now satisfy `AskUserQuestion` by returning `updatedInput` alongside `permissionDecision: "allow"`, enabling headless integrations that collect answers via their own UI."_ The user is on v2.1.138, so this capability is available.
2. The user runs CC in **tmux panes** (`tmuxSplitPanes: true` in `~/.claude/settings.json`), so the hook can identify the pane via `$TMUX_PANE` and inject keystrokes.
3. An MCP-side `ask_remote` tool already exists (`src/mcp/channel-relay/server.ts`) and ships the TG-inline-keyboard + Web UI tap-to-answer plumbing. That tool can only be called by _Claude_, not by external scripts — so the hook can't invoke it directly, but the bot's helpers underneath it are reusable.
4. The bot exposes a localhost HTTP server (Hono). Adding a new endpoint is cheap.
5. Anthropic's own "Remote Control" feature has the same gap on mobile (open bugs `anthropics/claude-code#33625`, `#28508`) — so this is not a problem with a vendor-shipped fix imminent.

## Goal

A built-in `AskUserQuestion` fires → the user sees the question on TG and Web UI immediately → the user can answer on any surface (local TUI, TG inline keyboard, Web UI tap) → first answer wins → the local TUI advances as if the user had typed locally.

**Non-goals (M1):**

- Cross-host remote (bot on a different machine than CC).
- Non-tmux fallback injection.
- Telemetry / mobile-vs-local win rate.
- Bridging the question into 3rd-party clients beyond TG and the existing Web UI.

## Design decisions

| #   | Decision                                                                                                                    | Rationale                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Parallel first-wins UX** (local TUI stays open; TG / Web UI also active; first answer on any surface resolves the AUQ)    | Matches Anthropic's permission-relay UX. User asked for it explicitly. Avoids "I'm at my desk, why can't I answer here?" frustration.              |
| 2   | **User-level hook** in `~/.claude/hooks/`, fires for every CC session                                                       | Zero per-project setup. The hook itself no-ops when the bot is unreachable or no watch matches the cwd, so plain `claude` sessions are unaffected. |
| 3   | **Multi-question AUQs → sequential TG cards** (one card per question, posted in order)                                      | Matches the local TUI's one-at-a-time flow. Reuses the existing single-question `ask_remote` UX pattern.                                           |
| 4   | **TG + Web UI in M1** (both surfaces, both tappable, first answer wins per question)                                        | Web UI already renders `ask_remote` events with tap-to-answer; reusing that path is nearly free.                                                   |
| 5   | **Hook returns immediately** (`permissionDecision: "allow"` with no `updatedInput`); detached worker handles the async side | PreToolUse hooks have a soft timeout (~5s). Keeping the hook entry fast (<100ms) means CC's tool dispatch is never blocked.                        |
| 6   | **`tmux send-keys` for keystroke injection** when mobile wins                                                               | The local TUI is open in parallel; injecting keystrokes is the cleanest way to let CC complete the AUQ via its normal code path.                   |
| 7   | **JSONL `tool_result` observation as the cancellation signal** when local wins                                              | The bot already tails JSONL. When the matching `tool_use_id` resolves, the bridge cancels the TG/Web cards. No new mechanism needed.               |
| 8   | **Localhost HTTP + shared-secret auth** between hook/worker and bot                                                         | Standard, simple, fits the bot's existing Hono server. Defense in depth against any other local process binding the endpoint.                      |

## Architecture

```
saas-builder CC (in tmux pane %12)
  ├─ AUQ tool_use fires
  ├─ CC spawns PreToolUse hook  ─────────────► ~/.claude/hooks/claude-remote-auq-bridge.sh
  │                                              ├─ reads stdin (CC's JSON)
  │                                              ├─ tool_name === "AskUserQuestion"?  → if no, passthrough
  │                                              ├─ bot reachable?                     → if no, passthrough
  │                                              ├─ spawn detached worker (nohup + disown):
  │                                              │   ~/.claude/hooks/claude-remote-auq-worker.ts
  │                                              └─ stdout: {permissionDecision: "allow"}
  │
  ├─ local TUI opens (passthrough; user CAN answer locally)                          ▲
  │                                                                                  │
  └─ when user OR worker provides answer → CC writes tool_result to JSONL ───┐       │
                                                                              ▼       │
detached worker process                                                       │       │
  ├─ POST localhost:<port>/api/auq-bridge ──────────────────────────┐         │       │
  ├─ GET /api/auq-bridge/<id>/answer (long-poll, 30s, retries)      │         │       │
  │                                                                  ▼         │       │
mobile-bridge bot (always running)                                              │       │
  ├─ POST /api/auq-bridge:                                                      │       │
  │    ├─ auth check (shared secret)                                            │       │
  │    ├─ resolve cwd → which active watch? → chatId+threadId                   │       │
  │    └─ register bridge: Map<request_id, BridgeState>                         │       │
  │                                                                              │       │
  ├─ For each question (sequentially):                                          │       │
  │    ├─ post TG inline keyboard via postQuestionToTelegram (existing)         │       │
  │    └─ emit `ask_remote` SSE event for Web UI (existing renderer)            │       │
  │                                                                              │       │
  ├─ ANY of these resolves the bridge:                                          │       │
  │    a) TG callback: user tapped a button                                     │       │
  │    b) Web UI POST /api/sessions/:id/ask-remote/:askId/answer                │       │
  │    c) Bus emit: tool_result with matching tool_use_id (local won) ◄─────────┘       │
  │                                                                                       │
  └─ When bridge resolves:                                                                │
       ├─ If answered on TG/Web: respond to worker's long-poll with answers              │
       │   └─ worker: tmux send-keys "<digit>\n" into pane %12 ──────────────────────────┘
       │       └─ CC's local TUI processes keystrokes, writes tool_result
       └─ If cancelled locally: respond with {status: "cancelled"}
           ├─ edit TG card to "✓ Answered locally"
           └─ emit ask_remote_cleared SSE
```

## Components

**New files (5):**

| Path                                          | Type          | LOC  | Responsibility                                                                                                                                                              |
| --------------------------------------------- | ------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.claude/hooks/claude-remote-auq-bridge.sh` | Bash          | ~40  | PreToolUse hook entry. Read stdin, validate, spawn detached worker, return `{permissionDecision: "allow"}` JSON. Must exit in <100ms.                                       |
| `~/.claude/hooks/claude-remote-auq-worker.ts` | Bun/TS script | ~120 | The long-running half. POST to bot, long-poll for answer, run `tmux send-keys` to inject. Detached from CC. Logs to `~/.claude/logs/auq-bridge-worker.log`.                 |
| `src/web/routes/auq-bridge.ts`                | Hono route    | ~100 | `POST /api/auq-bridge` (register) + `GET /api/auq-bridge/:id/answer` (long-poll). Localhost-only, shared-secret auth via `RELAY_AUQ_SECRET` env.                            |
| `src/handlers/auq-bridge.ts`                  | Bot handler   | ~200 | Per-bridge orchestrator. Loops questions, posts TG card per question, listens for taps + Web UI answers + bus `tool_result` cancellations. First-surface-wins per question. |
| `~/.claude/settings.json` (edited, not new)   | JSON          | +12  | Add `PreToolUse` hook entry with matcher `AskUserQuestion`.                                                                                                                 |

**Modified files (3):**

| Path                                              | Change                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web/server.ts` (or wherever Hono is mounted) | Mount the new `/api/auq-bridge` route.                                                                                                                                                                                                                                                                           |
| `src/handlers/relay-ask.ts`                       | Extract `postQuestionToTelegram` (currently called only from the MCP `ask_remote` path) into a shared helper the new bridge can call. Existing MCP path continues to use it unchanged. Also extend the inline-keyboard callback dispatcher to route `bridge:*` callback data to the new `auq-bridge.ts` handler. |
| `.env.example`                                    | Document the new `RELAY_AUQ_SECRET` shared-secret env var.                                                                                                                                                                                                                                                       |
| `README.md`                                       | New feature bullet under §Features.                                                                                                                                                                                                                                                                              |

**No changes to:**

- The relay TCP protocol (the bridge adds HTTP, a separate channel).
- The tailer / sink (cancellation hooks via existing bus subscription pattern; no new code there).
- The MCP `ask_remote` server (left alone — that's a different code path used directly by Claude).

## Wire protocol

**1. CC → hook (stdin, JSON):**

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "abc123",
  "tool_use_id": "toolu_01xyz",
  "tool_name": "AskUserQuestion",
  "tool_input": {
    "questions": [
      { "question": "How should...", "header": "Wizard shape",
        "options": [{"label": "Two steps", "description": "..."}, ...],
        "multiSelect": false }
    ]
  },
  "cwd": "/Users/azaidi/Projects/Cursor/saas-builder",
  "transcript_path": "/Users/.../<uuid>.jsonl",
  "permission_mode": "default"
}
```

**2. hook → CC (stdout, JSON) — passthrough so local TUI opens:**

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow"
  }
}
```

No `updatedInput`. CC proceeds with AUQ normally and opens its local picker.

**3. hook → worker (worker stdin):**

```json
{
  "request_id": "auq_<crypto.randomUUID>",
  "tool_use_id": "toolu_01xyz",
  "session_id": "abc123",
  "cwd": "/Users/azaidi/Projects/Cursor/saas-builder",
  "questions": [...],
  "tmux_pane": "%12"
}
```

**4. worker → bot `POST /api/auq-bridge`:**

Headers: `Authorization: Bearer <RELAY_AUQ_SECRET>`.

Body: same shape as #3.

Responses:

```json
// 200 — registered
{ "request_id": "auq_...", "chatId": -100..., "threadId": 6302 }
// 404 — no watch matches cwd; worker silently exits
{ "error": "no active watch for cwd" }
// 401 — bad auth
{ "error": "unauthorized" }
```

**5. worker → bot `GET /api/auq-bridge/:request_id/answer` (long-poll, 30s window, worker retries on 408):**

```json
// 200 — answered (TG, Web UI, or local-via-tmux-injection)
{
  "status": "answered",
  "answers": [
    { "question": "How should...", "answer": "Two steps" },
    { "question": "Next Q...", "answer": "<user's custom text>" }
  ]
}
// 200 — cancelled (local TUI answered first, JSONL tool_result observed)
{ "status": "cancelled", "reason": "answered_locally" }
// 408 — long-poll window elapsed with no resolution; worker retries
```

**6. bot → TG:** reuse the extracted `postQuestionToTelegram` helper. Per-question inline-keyboard card; "Type custom answer" affordance appended. Callback data uses a `bridge:<request_id>:<question_index>:<option_index>` namespace.

**7. bot → Web UI:** emit `ask_remote` SSE event per question (the existing Web UI renderer at `Terminal.tsx:642` already handles it):

```ts
bus.emit(sessionName, {
  type: "ask_remote",
  askId: `${request_id}:${question_index}`,
  askQuestion: q.question,
  askOptions: q.options.map((o) => ({
    label: o.label,
    description: o.description,
  })),
  askAllowCustom: !q.multiSelect,
  content: "",
});
```

Web UI answer flows back through the existing `POST /api/sessions/:id/ask-remote/:askId/answer` endpoint; the bot's existing dispatcher routes `bridge:*` askIds to the new `auq-bridge.ts` handler.

**8. worker → CC TUI (tmux send-keys per answer in order):**

- **Labelled option:** `tmux send-keys -t %12 Escape "N" Enter` where N is the 1-indexed option number in the question's options array.
- **Custom text:** `tmux send-keys -t %12 Escape` → press the "Type something." option's number → `Enter` → type the custom string (single-quote-wrapped, single quotes inside escaped via `'\''`) → `Enter`.
- 50ms sleep between answers so the TUI can redraw between questions.

**9. Cancellation signal flow (local wins):**

`auq-bridge.ts` subscribes to the bus for the bridge's session at registration. When a `tool_result` SseEvent with matching `tool_use_id` arrives:

1. Resolve the worker's pending long-poll with `{status: "cancelled", reason: "answered_locally"}`.
2. Edit pending TG inline-keyboard messages to "✓ Answered locally" (no buttons).
3. Emit `ask_remote_cleared` SSE event with `askResolution: "answered"` to clean up Web UI cards.

The reverse (mobile wins) handles itself implicitly: worker's `tmux send-keys` completes the TUI → CC writes JSONL → bot's tailer emits the `tool_result` → bridge sees it but is already resolved → no-op.

## Error handling

| #   | Scenario                                                        | Policy                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Bot unreachable                                                 | Hook returns passthrough immediately; local TUI handles AUQ unhooked. Worker never spawned.                                                                                                                                                      |
| 2   | No watch matches `cwd`                                          | Bot responds 404; worker exits silently; local TUI handles.                                                                                                                                                                                      |
| 3   | Wrong / missing auth secret                                     | Bot responds 401; worker exits silently.                                                                                                                                                                                                         |
| 4   | `$TMUX_PANE` not set                                            | Hook still spawns worker; user can read & answer on TG, but worker logs `cannot auto-inject: no tmux pane` and exits without injection. User types the answer manually on desktop. Graceful degradation.                                         |
| 5   | User answers in local TUI first                                 | Bot's tailer sees the `tool_result` for the matching `tool_use_id` → resolve worker with `cancelled`; edit TG card to "✓ Answered locally"; emit `ask_remote_cleared`.                                                                           |
| 6   | User answers on TG then notices Web UI; multi-question overlap  | First answer per `question_index` wins; other surface's card edits to "✓ Answered on TG" / "✓ Answered on Web" and disables.                                                                                                                     |
| 7   | Custom-text answer                                              | TG: existing relay-ask handler captures the next text message in chat as the answer. Web UI: existing free-text input. Worker injects via the "Type something." option + typed text. Custom string shell-escaped before `tmux send-keys`.        |
| 8   | `tmux send-keys` fails                                          | Worker logs to `~/.claude/logs/auq-bridge-worker.log` and exits. Bot still resolved cleanly on mobile, but TUI is stuck on the picker. User reads the answer on TG and types locally. Acceptable degradation.                                    |
| 9   | User hits Esc / Ctrl-C on local TUI                             | CC writes a cancellation tool_result. Bot's tailer sees it; bridge cancels with `askResolution: "cancelled"`. Worker resolves and exits.                                                                                                         |
| 10  | Bot restart while AUQ pending                                   | Worker's long-poll fails; retries N times (default 3, exponential backoff). If still failing, exits. Stale TG card stays in the chat (harmless visual noise).                                                                                    |
| 11  | Multi-question AUQ partial answers                              | Impossible per JSONL signal: CC writes the `tool_result` atomically when ALL questions are answered. So `tool_use_id` resolution = all answered. No partial state to reconcile.                                                                  |
| 12  | Worker race: bot answers AND `tool_result` lands simultaneously | Worker treats `status: "answered"` as authoritative even if `cancelled` also arrives; tmux injection becomes a no-op (TUI already moved on). Idempotent.                                                                                         |
| 13  | Custom text contains tmux-unsafe chars                          | Single-quote wrap + escape internal `'` as `'\''`. Standard shell-quoting hygiene.                                                                                                                                                               |
| 14  | `tool_use_id` collision (extremely unlikely)                    | Bridge map keyed by `tool_use_id + sessionName` to add a safety dimension.                                                                                                                                                                       |
| 15  | Hook script fails to exit within CC's hook timeout              | Worker detached so it survives hook exit — macOS-compatible pattern: `(nohup bun ... </dev/null >>log 2>&1 &); disown`. Measured target: hook body <50ms. If hook ever blocks, CC kills it and the tool runs unhooked (local-only) — acceptable. |

**Flagged risks:**

1. **Custom-text TUI injection (#7)** is the implementation wildcard. Bench-test required. M1 may ship without it (bot accepts custom text, user reads it and types locally) and add it in a polish PR after first real use.
2. **Hook timeout (#15)** — `nohup + disown` for clean detachment is standard but verify with `time` on first install. Mac's bash quirks around stdin closing can occasionally leave the parent waiting.

## Testing strategy

**Unit-testable (Bun, in `src/__tests__/`):**

| New test file                    | Coverage                                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `web-auq-bridge-route.test.ts`   | POST: 200 when watch matches; 404 when no watch; 401 on wrong auth; 400 on missing fields. GET long-poll: 200+answers when bridge resolves; 200+cancelled when `tool_result` observed; 408 when nothing happens within 30s.    |
| `auq-bridge-handler.test.ts`     | Single-question flow (post → simulated tap → resolve). Multi-question flow (sequential cards, per-question first-surface-wins). `tool_use_id` cancellation via injected bus emit. TG card editing on cancel. Custom-text path. |
| `auq-bridge-worker-keys.test.ts` | Given answer + question shape, asserts exact `tmux send-keys` argv. No real tmux invocation. Covers: label → digit, custom text → option-number + text + Enter, shell-escape for awkward strings.                              |
| `auq-bridge-hook.test.ts`        | Spawn the bash hook as subprocess, pipe sample CC stdin, assert stdout shape, exit code 0, wall-clock <200ms. Assert worker forked (marker file at `/tmp/auq-bridge-<id>.pid`).                                                |

**Characterization (lock current behavior):**

| File                                            | Why                                                                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event-flow-auq-bridge-no-interference.test.ts` | MCP `ask_remote` path is untouched but shares `postQuestionToTelegram`. Lock that the MCP-side flow still works end-to-end after the helper extraction. |
| Extension to `web-sse.test.ts`                  | The bridge emits `ask_remote` events with the same shape as the MCP tool. Lock format identical so the Web UI renderer doesn't branch.                  |

**Manual smoke (in spec, run during M1 acceptance):**

1. Install hook + worker; `bun run dev`; watch saas-builder topic in TG.
2. Trigger a built-in AUQ. Verify: local TUI shows picker, TG card appears <2s, Web UI shows question with tap-to-answer.
3. Tap on **TG**. Verify TUI advances; JSONL written; Web UI card shows "✓ Answered on TG".
4. Same setup, answer in **local TUI** first. Verify TG edits to "✓ Answered locally"; worker exits.
5. Same setup, tap on **Web UI**. Verify TUI advances; TG edits to "✓ Answered on Web".
6. Multi-question AUQ (3 questions). Verify each gets its own card sequentially.
7. **Custom text**: tap "Type custom answer" on TG, send string with quotes & special chars. Verify it lands in TUI correctly.
8. **Bot offline**: stop bot, trigger AUQ. Local TUI still works (graceful degradation).
9. **No watch**: run `claude` in unwatched project, trigger AUQ. Local TUI only, no TG card.
10. **Stale tmux pane**: trigger AUQ, manually close CC pane before answering. Worker exits cleanly.

**Baseline preservation:** 834/834 canonical tests (current `refactor/event-bus-symmetry` count) must remain green at every commit. New tests bring total to ~860+. Existing tests should require zero modifications.

## Rollout plan (commit order)

```
1. feat(web):     /api/auq-bridge endpoints + auth + unit tests        (no behavior change)
2. feat(handlers): src/handlers/auq-bridge.ts orchestrator + tests      (still inert)
3. refactor(relay-ask): extract postQuestionToTelegram as shared helper (MCP ask_remote unaffected)
4. wire:          mount /api/auq-bridge in Hono router                  (route reachable, unused)
5. feat(hooks):   claude-remote-auq-bridge.sh entry hook                 (script-only)
6. feat(hooks):   claude-remote-auq-worker.ts                            (script-only)
7. config:        register PreToolUse hook in ~/.claude/settings.json    ← GO-LIVE COMMIT
8. docs:          README bullet + smoke checklist                        (or fold into #7)
```

The hook only fires once step 7 lands. Reverting just step 7 disables the feature while leaving infrastructure intact.

## M2 deferrals (don't build now)

| Idea                                                             | Reason deferred                                             |
| ---------------------------------------------------------------- | ----------------------------------------------------------- |
| `osascript`-based injection fallback for non-tmux sessions       | User is tmux-only; wait for an actual non-tmux complaint.   |
| Worker restart-resilience (resume long-poll across bot restarts) | Stale TG card is harmless; rare.                            |
| Recover from stale tmux pane id (find the new live pane)         | Heuristics get messy; manual re-install fixes it.           |
| Cross-host (bot and CC on different machines)                    | Separate transport design (WireGuard / SSH tunnel / ngrok). |
| Telemetry: mobile-vs-local win-rate                              | Low priority.                                               |

## Dependencies & assumptions

- CC v2.1.85+ (confirmed: user on v2.1.138).
- `tmuxSplitPanes: true` (confirmed in `~/.claude/settings.json`).
- Bot running on localhost with the new endpoints mounted.
- The `RELAY_AUQ_SECRET` env var set both in the bot and in the worker's environment (sourced from `.env`).
- The existing JSONL tailer correctly emits `tool_result` events to `globalEventBus` with `toolUseId` populated (verified in `src/handlers/watch.ts` and the event-bus refactor's baseline tests).

## Open questions deferred to implementation

- Exact polling/sleep cadence inside the worker (start with 30s long-poll + 3 retries, tune if needed).
- Whether the bash hook script needs a unit test (40 LOC of glue; manual smoke probably covers it — decide during step 5).
- Whether to add a JSONL-tool_result-cancellation timing characterization test (real-world: how fast does the bot's tailer notice? May not be worth a formal test).

## References

- [Anthropic — Handle approvals and user input (`canUseTool`)](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Anthropic — Channels reference (permission-relay UX precedent)](https://code.claude.com/docs/en/channels-reference)
- [Claude Code CHANGELOG.md (v2.1.85 PreToolUse satisfies AUQ)](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md)
- `anthropics/claude-code#33625` — AUQ on Remote Control mobile UI missing
- `anthropics/claude-code#28508` — AUQ Remote Control answer not propagating
- Internal: `~/.claude/projects/-Users-azaidi-Projects-Cursor-AHZ-claude-mobile-bridge/memory/project_auq_jsonl_limitation.md`
- Internal: `docs/superpowers/specs/2026-05-06-session-event-bus-design.md` (the bus this bridge consumes from)
