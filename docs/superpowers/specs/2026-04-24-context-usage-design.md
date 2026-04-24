# Context Usage Display — Design

## Goal

Show per-session context window usage (like the statusline's `●●●○○○○○○○ 25%`) in `/status`, and optionally fire a Telegram notification when usage crosses configurable threshold buckets (10%/25%/50%).

## Background

User's statusline (`~/.claude/statusline-wrapper.sh`) displays context as:

```
current = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
pct     = current * 100 / context_window_size
```

Claude Code feeds `context_window_size` + usage into the statusline hook on stdin.

The bot already tails desktop CC transcripts (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`) via `src/sessions/tailer.ts`. Each assistant entry in the JSONL contains `message.usage` with the same four fields. Currently the tailer drops this block — `/status` shows `in/out` from `ClaudeSession.lastUsage`, which is the unused SDK path.

## Scope

**In:**

- Parse `message.usage` in tailer, stamp into a session-keyed registry
- `/status` displays `🧠 ●○○○○○○○○○ 5% (50k/1M)` line for the active mirrored session
- New `contextNotifyStep` setting: `off | 10 | 25 | 50` (off by default)
- Threshold-crossing notifications posted to the session's topic
- Unit tests for `computeContextPct`, `contextBar`, bucket-crossing logic

**Out:**

- SDK path (`src/session.ts` `ClaudeSession`) — not used
- Detecting 1M mode from config — CC doesn't expose it reliably; hardcode window = 1,000,000
- Per-session window override
- Displaying context in the pinned status message (`src/sessions/status-message.ts`)
- Per-turn streaming footer display

## Architecture

### 1. Usage extraction (`src/sessions/tailer.ts`)

In the `entry.type === "assistant"` branch (tailer.ts:341), after iterating content blocks, read `entry.message.usage` and emit a new `TailEvent`:

```ts
type TailEvent =
  | ... existing variants
  | { type: "usage"; usage: TokenUsage; sessionId: string };
```

Tailer stays pure — callers own persistence. `TokenUsage` already exists in `src/types.ts:30-35`.

### 2. Usage registry (`src/sessions/context-usage.ts` — new)

Module-level map keyed by session UUID:

```ts
const CONTEXT_WINDOW = 1_000_000;

interface ContextState {
  lastUsage: TokenUsage;
}

const registry = new Map<string, ContextState>();

export function recordUsage(sessionId: string, usage: TokenUsage): void;
export function getContextState(sessionId: string): ContextState | undefined;
export function computeContextPct(u: TokenUsage): number;
export function contextBar(pct: number): string; // ●●●○○○○○○○
export function formatContextLine(u: TokenUsage): string; // 🧠 ●... NN% (Xk/1M)
export function checkThresholdCrossing(
  prevBucket: number,
  pct: number,
  step: number,
): { fire: boolean; bucket: number };
```

`lastNotifiedBucket` lives on `WatchState` in `src/handlers/watch.ts`, not in the registry — it's per-watch runtime state, not per-session persistent state.

`checkThresholdCrossing` rules:

- `step === 0` → never fire.
- `bucket = Math.floor(pct / step) * step`.
- `fire = bucket > prevBucket`.
- If `pct` drops below `prevBucket` (e.g. after `/compact`), caller resets state to 0. (Implemented in the consumer, not the pure helper.)

### 3. Tailer wiring (`src/handlers/watch.ts`)

Where `WatchState` receives `TailEvent`s (watch.ts callback at tailer.ts:504, 631, 839):

```ts
case "usage": {
  recordUsage(event.sessionId, event.usage);
  const step = getContextNotifyStep();          // 0 if unset
  if (step > 0) {
    const pct = computeContextPct(event.usage);
    const prev = watchState.lastNotifiedBucket ?? 0;
    if (pct < prev) {
      watchState.lastNotifiedBucket = 0;        // compact / reset
    }
    const { fire, bucket } = checkThresholdCrossing(watchState.lastNotifiedBucket ?? 0, pct, step);
    if (fire) {
      await ctx.api.sendMessage(chatId, `⚠️ Context ${pct}%`, {
        message_thread_id: threadId,
      });
      watchState.lastNotifiedBucket = bucket;
    }
  }
  break;
}
```

`lastNotifiedBucket` is added to `WatchState` (watch.ts:138).

### 4. `/status` display (`src/handlers/commands.ts`)

Delete the existing usage block (commands.ts:953-958). The `📈 Xk in / Yk out` line was sourced from `session.lastUsage` (SDK path) and never fires for mirrored sessions, so its removal is a no-op for the user. Replace with:

```ts
const sid = activeSession?.info.id || session.sessionId;
const ctxState = sid ? getContextState(sid) : undefined;
if (ctxState) {
  lines.push(formatContextLine(ctxState.lastUsage));
}
```

### 5. Settings (`src/settings.ts`)

```ts
interface BridgeSettings {
  // ... existing
  contextNotifyStep?: number; // 0|10|25|50; undefined = off (treated as 0)
}

export function getContextNotifyStep(): number {
  return ensure().contextNotifyStep ?? 0;
}
```

Sanitize: accept only `0 | 10 | 25 | 50`.

### 6. Settings UI (`src/handlers/settings.ts` + `callback.ts`)

Add a row "Context notify: off / 10% / 25% / 50%" to `renderSettingsBody()` and an entry in `renderSettingsKeyboard()`. Cycle on→10→25→50→off on tap (same pattern as `autoWatchOnSpawn`). Wire into `handleSettingsCallback` in `src/handlers/callback.ts`. Persist via `saveSetting({ contextNotifyStep: N })`.

## Data Flow

```
CC writes assistant turn ──▶ JSONL line
        │
        ▼
SessionTailer.parseLine ──emits──▶ TailEvent{type:"usage", usage, sessionId}
        │
        ▼
watch.ts handleEvent
        ├─▶ recordUsage(sid, usage)   ──▶ context-usage.ts registry
        └─▶ if step>0 && crossed bucket ──▶ sendToTopic(chatId, threadId, "⚠️ Context N%")

/status command ──▶ getContextState(sid) ──▶ formatContextLine ──▶ reply line
```

## Edge Cases

- **No usage seen yet**: `getContextState` returns `undefined`; `/status` omits the line. No notification fires.
- **Multiple concurrent watches** (topic A and topic B watching different sessions): registry is keyed by session UUID, not topic. Each `WatchState` holds its own `lastNotifiedBucket`, so notifications don't cross-fire.
- **Session resume / new sessionId**: new session UUID → fresh registry entry. Old entry is harmless, cleaned up on bot restart.
- **Compact (`/compact`) shrinks context**: next turn's usage is smaller; `pct < lastNotifiedBucket` → reset bucket to 0 so future growth re-fires.
- **usage field missing / malformed**: ignore; emit no event.
- **Window mismatch (user on 200k, not 1M)**: % displays smaller than reality. Acceptable — only relevant for this user, who runs 1M. If a second user hits this, add detection then.

## Tests

`src/__tests__/context-usage.test.ts` (new):

- `computeContextPct`
  - all four fields summed
  - missing optional cache fields → treated as 0
  - caps at 100
- `contextBar`
  - 0% → 10 empty
  - 25% → 2 filled
  - 100% → 10 filled
  - 105% → 10 filled (no overflow)
- `checkThresholdCrossing`
  - step=0 → never fires
  - crosses 25→50 with step=25 → fires at bucket=50
  - same bucket twice → no re-fire
  - drop below prev bucket triggers caller-reset path (test the reset logic in tailer wiring, not pure helper)
- `formatContextLine`
  - formats `50_000 input + 0 cache` as `🧠 ... 5% (50k/1M)`

Integration test for tailer: feed a fake assistant JSONL line with `usage`, expect `{type:"usage", ...}` event.

## Resolved

- `📈 Xk in / Yk out` line is dropped — dead on the mirrored path.
- `lastNotifiedBucket` is in-memory only; resets on bot restart (one extra notification next climb is acceptable).
- Notification delivery uses `ctx.api.sendMessage(chatId, text, { message_thread_id })`.
