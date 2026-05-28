# Phase 1 · Task 7 — Singleton retirement

**Parent:** `2026-05-25-phase-1-session-context.md`
**Branch:** `refactor/phase-1-session-context` (continues from commit `4b919f2`)
**Goal:** Delete `src/session.ts` singleton + `getActiveSession()` + `warmSingletonFromSctx`. Per-session state lives in a `SessionState` container resolved at handler entry from `SessionContext`. Streaming SDK wrapper becomes stateless.

## Why this task is special

Tasks 3–6 were _additive_: routing became explicit via `sctx`, but every handler still falls back to the global `session` singleton (warmed inline via `loadFromRegistry(si)` or `warmSingletonFromSctx`). Task 7 is the _deletion_ step. Once it lands, two sessions can actually be in-flight simultaneously without their state stomping on each other.

This is also the riskiest task in phase 1 because the singleton owns:

- Per-session data the handlers read directly (`sessionId`, `lastMessage`, `pendingPlanApproval`, `lastError`, `lastUsage`, `workingDir`, `sessionName`).
- Live per-query state mutated _inside_ the streaming callback (`queryStarted`, `currentTool`, `lastTool`, `isQueryRunning`, `abortController`, `stopRequested`, `_isProcessing`, `_wasInterruptedByNewMessage`, `_isPlanMode`).
- Process-global config (`model`, `onModeChange`).

Each sub-task lands as one commit. Branch stays green throughout. Phase 0 scenarios (especially S2 — photo-to-cc-via-topic) are the regression guard. `web-tasks-route` SSE test is a known flake — ignore.

## Out of scope

- `handleSwitch` keeps `getActiveSession()`. The v1 global-pointer concept lives until phase 2.
- Don't rename `session.ts` to a new path mid-migration; the final sub-task (7g) handles file relocation.
- Cursor sessions need per-session state too (lastMessage for /retry, lastError for /status) — they DON'T use the streaming SDK, but they DO need a `SessionState` entry so command handlers don't crash on them.

## Pre-flight (no commit)

```bash
git checkout refactor/phase-1-session-context
bun run typecheck && bun run test
bun test src/__tests__/scenarios/   # baseline
grep -rn "session\." src/handlers src/bot.ts src/index.ts src/topics/topic-router.ts src/web/routes/sessions.ts | grep -v "//.*session\." | wc -l
# expect ~50 call sites — this is what we're retiring
```

## Sub-tasks

---

### 7a. Introduce `SessionState` container (additive)

**Changes**

- New file `src/sessions/session-state.ts`:
  - `class SessionState` with fields: `sessionId: string | null`, `sessionName: string`, `workingDir: string`, `lastActivity: Date | null`, `lastMessage: string | null`, `lastError: string | null`, `lastErrorTime: Date | null`, `lastUsage: TokenUsage | null`, `lastTool: string | null`, `currentTool: string | null`, `queryStarted: Date | null`, `pendingPlanApproval: PlanApprovalState | null`, `isPlanMode: boolean`, plus the per-query control fields (`abortController`, `isQueryRunning`, `stopRequested`, `_isProcessing`, `_wasInterruptedByNewMessage`).
  - Helper methods that today live on `ClaudeSession`: `consumeInterruptFlag()`, `markInterrupt()`, `clearStopRequested()`, `startProcessing()`, `stop()`, `kill()`, `clearSession()`, `setWorkingDir()`, `loadFromRegistry(SessionInfo)`, `get isActive() / isRunning`, `get pendingPlanApproval`, `clearPendingPlanApproval()`.
  - **Plan-approval reply queue:** keep the existing deferred shape — `pendingPlanApproval` is per-SessionState, so the deferred is implicitly per-session.
  - `onModeChange?: (planMode: boolean) => void` callback lives on SessionState (same shape as singleton).
- `getSessionState(name: string): SessionState` — resolver. Map<string, SessionState> keyed by `sessionName`. Creates lazily.
- `dropSessionState(name: string): void` — for `killSession` cleanup.
- `listSessionStates(): SessionState[]` — for debugging / web routes if needed.
- Export from `src/sessions/index.ts`.

**Why**
Adds the storage without changing behaviour. The singleton continues to be the source of truth; the new map is unused. Lets the rest of the migration land in small commits.

**Hidden hazard**
`SessionState.onModeChange` mutates the pinned status (today wired in `src/index.ts`). For now, expose the same callback shape so callers can wire it per-state in 7c/7e. The singleton can still install its own callback.

**Verification**

```bash
bun run typecheck
bun test src/__tests__/scenarios/
```

**Acceptance**

- `SessionState` exists, compiles, exported via `src/sessions/index.ts`.
- `bun run test` green.
- No handler changes yet — diff should only add the new file and the export line.

---

### 7b. Carve a stateless streaming wrapper out of `ClaudeSession`

**Changes**

- In `src/session.ts`, extract two exported functions:

  ```ts
  export async function runQueryStreaming(
    state: SessionState,
    opts: {
      message: string;
      username: string;
      userId: number;
      statusCallback: StatusCallback;
      chatId?: number;
      ctx?: Context;
      permissionMode?: "bypassPermissions" | "plan";
      telemetry?: RequestTelemetry;
      model: ModelId;
    },
  ): Promise<string>;

  export async function runPlanApproval(
    state: SessionState,
    opts: { action: "accept" | "reject" | "edit"; feedback: string; ... },
  ): Promise<string>;
  ```

  These contain the bodies of `sendMessageStreaming` / `respondToPlanApproval`, but every `this.xxx` becomes `state.xxx`.

- `ClaudeSession.sendMessageStreaming` becomes a thin delegate: `return runQueryStreaming(this._asState(), {...})` where `_asState()` returns a temporary view object. Simplest path: have `ClaudeSession` _be_ a `SessionState` (extends it) so `this` IS the state. Then the methods just call the free functions with `this`.
- `model` stays on `ClaudeSession` as a property for now (still global in v1; see risk #3 below). The stateless wrapper takes it as an arg.
- `autoApproveWebTools`, helpers (`getThinkingLevel`, `extractFileDirectives`, `stripFileDirectives`) stay where they are.

**Why**
Decouples query execution from "the one true session." The streaming callback closures now write to a passed-in `SessionState` reference, so two queries can run in parallel against different SessionStates without interfering.

**Hidden hazards**

- The streaming callback writes `state.currentTool`, `state.lastTool`, `state.queryStarted`, `state.lastUsage`, `state.sessionId` (on first message). These all must point at the _passed-in_ state, not via closure on `this`. Audit every assignment when relocating the body.
- The `updateSessionId(this._sessionName, ...)` call must use `state.sessionName`.
- The `saveSession()` private writes to a single `SESSION_FILE` — keep as-is for now; the file is a startup-resume hint and not per-session. (Phase 2 will revisit.)
- `process.env.TELEGRAM_CHAT_ID = String(chatId)` — process-global side effect for the ask_user MCP server. Keep, but flag for cleanup in phase 4/5.

**Verification**

```bash
bun run typecheck
bun test src/__tests__/plan-mode.test.ts
bun test src/__tests__/ask-user-question.test.ts
bun test src/__tests__/scenarios/photo-to-cc-via-topic.test.ts
bun run test
```

**Acceptance**

- New free functions exist and are exported from `src/session.ts`.
- `ClaudeSession` methods are 1-line delegates.
- Behaviour unchanged. All tests green.

---

### 7c. Migrate `text.ts` to SessionState directly

**Changes**

- `src/handlers/text.ts`:
  - At the top of `handleText`, after the cursor early-return path, resolve `state = sctx?.source === "cc" ? getSessionState(sctx.sessionName) : undefined`. (Cursor sessions skip the SDK, but still get a state for /retry/lastMessage — done in 7e, not here.)
  - Drop the `if (si) session.loadFromRegistry(si)` warm-up — replace with `state.loadFromRegistry(si)` (or skip if SessionState was already populated by the watcher event bus — see risk #4).
  - Replace every `session.xxx` read with `state.xxx`:
    - `session.pendingPlanApproval` → `state.pendingPlanApproval`
    - `session.sessionId = null` (in `/clear`) → `state.clearSession()`
    - `session.lastMessage = message` → `state.lastMessage = message`
    - `session.sessionName` lookup before getActiveSession fallback → use `state.sessionName`
  - Replace `session.sendMessageStreaming(...)` / `session.respondToPlanApproval(...)` calls with `runQueryStreaming(state, {...})` / `runPlanApproval(state, {...})` imports from `src/session.ts`.
  - Drop the `getActiveSession` import + fallback at line ~476 — if `sctx` didn't yield a state, return the existing "No desktop session found" message (the relay path also fails fast).

**Why**
text.ts is the highest-volume consumer. Once it's off the singleton, Phase 0 S2 directly exercises the new path.

**Hidden hazards**

- The interrupt flag (`consumeInterruptFlag`, `markInterrupt`, `clearStopRequested`) — `checkInterrupt(message)` in `src/utils.ts` writes to _the singleton_. Audit `src/utils.ts`. Either thread `state` into `checkInterrupt`, or have `checkInterrupt` read the state from a passed-in arg. Plan: `checkInterrupt(message, state?)`. If we miss this, the `!`-prefix interrupt stops the wrong session.
- The /clear branch updates `updateTopicMapping(topicCtx.sessionName, { sessionId: undefined })` — keep, plus call `state.clearSession()`.
- The plan-approval revised-plan keyboard check (`if (session.pendingPlanApproval)` after a query) — must read `state.pendingPlanApproval` _after_ `runQueryStreaming` resolved, since the wrapper sets it on the state.

**Verification**

```bash
bun run typecheck
bun test src/__tests__/scenarios/photo-to-cc-via-topic.test.ts   # not affected but smoke
bun test src/__tests__/plan-mode.test.ts
bun test src/__tests__/scenarios/   # full scenario sweep
```

**Acceptance**

- `text.ts` imports nothing from `../session` except the free functions and `ModelId`/`MODEL_DISPLAY_NAMES`.
- No `getActiveSession` import in text.ts.
- Phase 0 S2 green.

---

### 7d. Migrate `photo.ts`, `voice.ts`, `document.ts`, `media-group.ts`, `callback.ts`

**Changes**

- Same pattern as 7c: resolve `state` at entry, drop the `session.loadFromRegistry` warm-up, replace `session.xxx` reads/writes with `state.xxx`, replace `session.sendMessageStreaming` calls with `runQueryStreaming(state, ...)`.
- For `callback.ts`:
  - `plan:` accept/reject: resolve state from the pending-plan-approval's owning session (the plan callback message_id → topic → sessionName chain already exists via `sctx`). Use `state.pendingPlanApproval` + `runPlanApproval(state, ...)`.
  - `model:` callback: keep `session.setModel` for now (global-model decision deferred — see risk #3). Just stop reading `session.workingDir` for the pin; use `sctx.sessionDir` or `state.workingDir`.
  - `auq:` callbacks: route through `runQueryStreaming(state, ...)`.

**Why**
Drains the remaining media/callback singleton readers. After this, every flow that _starts a query_ uses SessionState.

**Hidden hazards**

- `photo.ts:73`, `document.ts:233,372`, `voice.ts:113` — `session.startProcessing()` returns a cleanup function. Use `state.startProcessing()`.
- `media-group.ts` — small file; same treatment.
- `callback.ts` `plan_pick:` / `sess_pick:` / `sess_resume:` — these operate on `SessionInfo` directly without a SessionState; they're already correct, but verify they don't fall back to singleton.

**Verification**

```bash
bun run typecheck
bun test src/__tests__/ask-user-question.test.ts
bun test src/__tests__/plan-mode.test.ts
bun test src/__tests__/scenarios/
```

**Acceptance**

- None of `photo.ts`/`voice.ts`/`document.ts`/`media-group.ts`/`callback.ts` import `session` from `../session` for state purposes. They may still import `MODEL_DISPLAY_NAMES`, `type ModelId`, and the free functions.

---

### 7e. Migrate `commands.ts` + `relay-bridge.ts` + `topics/topic-router.ts` + drop `warmSingletonFromSctx`

**Changes**

- `commands.ts`:
  - `handleStatus`: read entirely from `state = getSessionState(sctx.sessionName)`. Drop `warmSingletonFromSctx`. The fallbacks (`activeSession?.info.dir`, etc.) stay for the `!sctx` General-topic path that ends in `resolveTopicSession` → picker.
  - `handleStop` / `handleKill`: use `state.stop()` and `state.kill()`. `killSession` helper: drop `getActiveSession()` check + `session.kill()`; instead, look up the killed session's state via `getSessionState(sessionInfo.name)`, call `state.stop()` + `state.kill()` if running, then `dropSessionState(sessionInfo.name)`.
  - `handleRetry`: today reads `session.lastMessage` globally. New shape: resolve `sctx` (signature change: `handleRetry(ctx, sctx?)`), read `state.lastMessage`. If `sctx` undefined → reply "Use /retry in a session topic" (or fall through to General-topic picker — pick one and document).
  - `handleModel`: same as `handleStatus`. Reads `session.model` / `session.modelDisplayName` — keep them on `ClaudeSession` global for v1 OR move to per-state (see risk #3).
  - `handlePin`: same; use `state.isPlanMode`, `state.workingDir`.
  - Delete the `warmSingletonFromSctx` helper.
- `relay-bridge.ts`:
  - Drop `session.workingDir` fallback at line 192/601 — already has `sctx.sessionDir`. The session lookup that today calls `session.xxx` should use `getSessionState(sctx.sessionName).workingDir`.
- `topics/topic-router.ts:76` — `session.loadFromRegistry(si)` → call `getSessionState(si.name).loadFromRegistry(si)`. Or delete this warm-up entirely if no downstream still needs it.
- `handlers/streaming.ts` — verify it doesn't read singleton state (grep was empty above; double-check after migration).

**Why**
Removes the last in-tree warm-up sites. Once this lands, the singleton's _only_ readers are bot.ts/index.ts (status-pin wiring) and watcher (none) and tests.

**Hidden hazards**

- `handleStop` / `handleKill` in General topic with multiple sessions — `resolveTopicSession` shows a picker. The picker's callback ends up back in commands.ts via a `stop:` / `kill:` callback (already migrated in task 5) — those carry the picked `SessionInfo`, which we now translate to a state via `getSessionState(info.name)`.
- `handleRetry` signature change — update the registration in `src/bot.ts` to thread `sctx`.
- The model setting is global today (saved via `saveSetting({ defaultModel })`). If we keep `ClaudeSession` alive purely as a model holder, that's fine; risk #3 picks an option.

**Verification**

```bash
bun run typecheck
bun test src/__tests__/commands.test.ts
bun test src/__tests__/scenarios/
bun run test
```

**Acceptance**

- `grep -n warmSingletonFromSctx src/handlers/commands.ts` → 0 hits.
- `grep -rn "session\." src/handlers src/topics/topic-router.ts | grep -v "state\.\|sctx\.\|sessionInfo\.\|sessionStat\|//"` should be near-empty (only legitimate fields on local SessionInfo / sessionName variables).
- All tests green.

---

### 7f. Migrate `bot.ts`, `src/index.ts`, `src/web/routes/sessions.ts`, `src/handlers/settings.ts`, `src/handlers/watch.ts`

**Changes**

- `src/index.ts:112` — `session.onModeChange = (isPlanMode) => { ... pinned status ... }` — move the pinned-status wiring out of singleton-mode-change-callback land. Options:
  - **(a)** Install a per-SessionState `onModeChange` whenever a SessionState is created (factory `getSessionState`). The callback closes over the session name and updates that session's pinned status.
  - **(b)** Drop the mode-change callback and have `runQueryStreaming`/`runPlanApproval` emit a `globalEventBus.emit(sessionName, {type: "mode_change", ...})` event, with bot.ts subscribed. Cleaner; preferred.
    Pick **(b)**.
- `src/bot.ts:177` — pinned-status init reads `session.workingDir` / `session.isPlanMode` / `session.modelDisplayName`. Replace with reads from "the bootstrap session" derived from `getActiveSession()` (which still exists at this sub-task; deleted in 7g). After 7g, this becomes "for each known SessionState, install a pin update subscriber."
- `src/web/routes/sessions.ts` — imports `session as claudeSession`. Audit usage; likely needs the same SessionState lookup, or just removal if the route doesn't need live state.
- `src/handlers/settings.ts` — uses `session` for model display. Same swap.
- `src/handlers/watch.ts` — already mostly clean per the grep; verify and swap any residual `session.xxx`.

**Why**
These are infra wireups, not query consumers. Easier to migrate after the handler bodies are done since the data flow becomes obvious.

**Hidden hazards**

- The mode-change event bus channel name — must use sessionName, not chatId. Pinned-status update happens per-session.
- `index.ts` boot order — SessionState map is empty at boot. The `onModeChange` subscription must be lazy (subscribe on first SessionState creation) or eager (sweep `getSessions()` at boot and pre-create states). Go lazy.

**Verification**

```bash
bun run typecheck
bun run test
```

**Acceptance**

- Only `src/session.ts` itself + tests import from `../session` for state purposes.

---

### 7g. Delete `ClaudeSession` singleton + `getActiveSession()` + relocate file

**Changes**

- `src/session.ts`:
  - Delete the `ClaudeSession` class.
  - Delete `export const session = new ClaudeSession()`.
  - Keep: `runQueryStreaming`, `runPlanApproval`, `autoApproveWebTools`, `MODEL_DISPLAY_NAMES`, `ModelId`, `getModelDisplayName`, `DEFAULT_MODEL` (now exported as `getDefaultModel()` function).
  - Rename file to `src/streaming/claude-sdk.ts` if desired; update imports across the tree.
- `src/sessions/watcher.ts`:
  - Delete `getActiveSession()` function.
  - Keep `cache.active` for `setActiveSession` (still used by `handleSwitch`, the offline picker, and the watch start logic). Expose `getActiveSessionName(): string | null` if some callers need just the name — but inspect first; many can be replaced with `getSessions()[0]` or removed entirely.
- `src/sessions/index.ts`:
  - Drop `getActiveSession` from the re-export list. Keep `setActiveSession` (handleSwitch uses it).
- Update callers of `getActiveSession()`:
  - `handleSwitch` (`commands.ts:1340`): replace with `getSession(name)` lookup directly — `setActiveSession` already returned a bool, so after it succeeds, do `getSession(name)`.
  - `killSession` (`commands.ts:823`): we already restructured this in 7e to look up by `sessionInfo.name`; double-check no residual `getActiveSession` call.
  - `respawnSession` (`commands.ts:967`): replace the "did spawn produce a session with the same name" check with `getSession(target.name)` (still exists) + `getSessions()` first-by-cwd.
  - `commands.ts:1003` `handleRespawn` fallback to "active" session — replace with "pick first session in dir" or "show picker."
  - `bot.ts:177` — addressed in 7f.
  - `web/routes/sessions.ts` — addressed in 7f.
  - Tests — addressed in 7g test mocks section below.

**Why**
The final removal. After this commit, there is no global "the session"; there is only a Map<sessionName, SessionState> and the watcher's cache of SessionInfo.

**Hidden hazards**

- `cache.active` is _persisted_ to disk (`ACTIVE_SESSION_FILE`). Keep persistence — it's the "remember which session the user last picked across restarts" hint and still serves the v1 picker.
- Some callers want "the session for this directory" (e.g., the bot startup pin). Provide a helper `getSessionByDir(dir): SessionInfo | null` in the watcher if useful; don't synthesize a `getActiveSession()` replacement.

**Test mock migrations**
Each of these files mocks `../session` (or `../../session`). Update them:

1. `src/__tests__/plan-mode.test.ts` — replace singleton mock with mocks of `runQueryStreaming` / `runPlanApproval` and `getSessionState` from `../sessions`.
2. `src/__tests__/smoke.test.ts` — likely just imports session; may become unnecessary.
3. `src/__tests__/ask-user-question.test.ts` — mock the free function `runQueryStreaming`.
4. `src/__tests__/commands.test.ts` — mock `getSessionState` + `runQueryStreaming`. handleStop / handleStatus / handleModel tests need `getSessionState` returning a stub.
5. `src/__tests__/settings-handler.test.ts` — mock model getters.
6. `src/__tests__/notifications.test.ts`, `auto-watch-retry.test.ts`, `topics-integration.test.ts` — confirm by grep; likely shallow.

**Verification**

```bash
grep -rn "getActiveSession" src --include="*.ts" | grep -v __tests__ | grep -v __mocks__
# expect: empty
grep -rn 'from "../session"\|from "./session"' src --include="*.ts" | grep -v __tests__
# expect: only the streaming-SDK function imports, no `import { session }`
bun run typecheck
bun run test
bun test src/__tests__/scenarios/
```

**Acceptance**

- `getActiveSession` is gone from non-test source.
- `import { session }` is gone from non-test source.
- `_activeSessionName` is gone (it never existed under that name — `cache.active` is the actual var; the original task description was slightly off. Confirm in `watcher.ts`).
- `bun run test` is green (modulo the known `web-tasks-route` flake).
- Phase 0 scenario tests pass.

---

## Risks & decisions

### R1. Streaming callbacks write per-session state

Mitigated in 7b: the free function takes `state: SessionState` and every assignment writes via the passed-in reference. Two queries running in parallel against different states won't interfere. Audit every `this.xxx =` in the extracted body — there are ~15 sites in `sendMessageStreaming`.

### R2. Plan-approval reply queue

Today `respondToPlanApproval` reads `this._pendingPlanApproval`, clears it, then calls `sendMessageStreaming` again. Per-SessionState this naturally works because the `pendingPlanApproval` field lives on the state. No deferred-promise queue change needed; the "wait for the user to click" is implemented by the handler simply returning, with state stored on the SessionState until the callback fires.

### R3. Model — global or per-session?

The model setting is global today (`saveSetting({ defaultModel })`, env `CLAUDE_MODEL`, `~/.claude/settings.json`). Two reasonable choices:

- **(a)** Keep model global. A small `src/streaming/model.ts` module owns `currentModel: ModelId` + `setModel/getModel`. `/model` writes there; `runQueryStreaming` accepts model as an arg.
- **(b)** Per-session model. `SessionState.model`. `/model` only affects the current session. New sessions default from settings.

**Pick (a) for task 7.** Global model is the v1 behaviour users expect, and per-session model is a feature change (out of scope per "no new features"). Park (b) for phase 5 if requested.

### R4. Working dir

`session.workingDir` is per-session conceptually. Move to `SessionState.workingDir`. The _global default_ for `/new` spawns comes from `getWorkingDir()` in `src/settings.ts` — that's separate and stays. After 7e, `getWorkingDir()` is the only "default cwd for next spawn" source; per-session cwd is `state.workingDir`.

### R5. Tests

~5–8 test files mock `../session`. Enumerated in 7g. Each migration is small (replace `session: { sendMessageStreaming: mock... }` with a `getSessionState` returning a stub + a `runQueryStreaming` mock). Update test imports of `../sessions/index` if the re-export list changes.

### R6. Cursor sessions

Cursor sessions don't use the streaming SDK but DO need a SessionState if `/retry` or `/status` is invoked. In 7a, `getSessionState(name)` creates lazily for any session name — no source check needed. `/retry` for a cursor session re-emits the last message via `globalEventBus` instead of calling `runQueryStreaming` — `handleRetry` already branches on `sctx.source === "cursor"`. Document in 7e.

## Sub-task order rationale

7a (additive) → 7b (carve out, singleton still delegates) → 7c–7f (migrate readers one cluster at a time, branch green at every step) → 7g (delete). This is the minimum-risk decomposition.

## Done criteria

- `src/session.ts` reduced to free functions + model + type exports (or moved to `src/streaming/claude-sdk.ts`).
- `getActiveSession()` deleted from `src/sessions/watcher.ts` and `src/sessions/index.ts`.
- `warmSingletonFromSctx()` deleted from `src/handlers/commands.ts`.
- No `import { session }` outside tests.
- `bun run test` clean (modulo `web-tasks-route` flake).
- Phase 0 scenarios all green.
- Update `docs/superpowers/notes/2026-05-25-phase-1-handoff.md` to mark task 7 done; flag task 8 (cursor lastActivity bumping) as next.
