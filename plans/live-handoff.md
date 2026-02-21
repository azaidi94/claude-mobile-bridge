# Live Desktop ↔ Mobile Handoff — Implementation Plan

## Feature Overview

Three sub-features that give true device continuity:

1. **Watch mode** — `/watch` a desktop session; tool calls and text stream to your phone in real-time
2. **Takeover** — While watching, type a message to inject into the desktop session's conversation
3. **Resume** — Desktop session goes offline; pick up on mobile with full context

---

## Architecture

### Core Component: `SessionTailer` (`src/sessions/tailer.ts`)

A new class that tails a desktop session's JSONL file and emits parsed events in real-time.

```
~/.claude/projects/<project>/<session-id>.jsonl
  ↓ (fs.watch + polling)
SessionTailer
  ↓ (parsed events)
WatchCallback → Telegram messages
```

**Key design decisions:**

- Uses `fs.watch` for instant updates + periodic stat-based polling as fallback (same pattern as `watcher.ts`)
- Reads from the last known file offset to avoid re-processing old events
- Parses JSONL entries into typed events: `assistant_text`, `assistant_tool`, `assistant_thinking`, `user_message`
- Emits events through a callback, same pattern as `StatusCallback`

### Watch State Management

Per-chat watch state stored in a `Map<number, WatchState>` (chatId → state):

```typescript
interface WatchState {
  sessionName: string; // Which session is being watched
  sessionId: string; // Session UUID
  tailer: SessionTailer; // Active tailer instance
  chatId: number; // Telegram chat to send updates to
  lastEventTime: number; // For activity detection
}
```

### Takeover Mechanism

When a user sends a message while watching a desktop session:

1. Stop the tailer (stop watching)
2. Load the desktop session into the bot's `ClaudeSession` via `loadFromRegistry()` (already works — session ID + cwd is all that's needed)
3. Send the user's message through `sendMessageStreaming()` with `resume: sessionId`
4. The Agent SDK resumes the conversation with the same session ID, preserving full context
5. The desktop Claude process will error/disconnect (it can't share a session), which is expected

This works because the Agent SDK's `resume` option reconnects to an existing session by UUID. The bot already uses this for its own sessions — we just point it at the desktop session's UUID.

### Resume Flow

When a watched desktop session goes offline (detected by watcher's `removed` diff):

1. Notify the user: "Desktop session went offline. Reply to continue here."
2. The session is already loaded (from watch or automatic discovery)
3. Next message from the user sends through `sendMessageStreaming()` with the desktop session ID
4. Conversation picks up exactly where the desktop left off

---

## Implementation Steps

### Step 1: `SessionTailer` class

**File:** `src/sessions/tailer.ts` (new)

Responsibilities:

- Accept a JSONL file path and start offset
- Watch for new lines appended to the file
- Parse each line into a typed event
- Call a provided callback with each event
- Clean shutdown via `stop()`

Event types to emit:

- `text` — Assistant text block
- `tool` — Tool use (name + input summary)
- `thinking` — Thinking block
- `user` — User message (from desktop)
- `error` — Parse/read error

Uses `Bun.file()` for efficient reads and `fs.watch()` for change detection. Polls every 2 seconds as backup. Reads only new bytes since last offset to minimize I/O.

### Step 2: Watch handler

**File:** `src/handlers/watch.ts` (new)

**Commands:**

- `/watch [session-name]` — Start watching a desktop session. If no name given, watch the active session. Only watches `source: "desktop"` sessions.
- `/unwatch` — Stop watching.

**Display format for streamed events:**

- Tool use: Same `formatToolStatus()` as existing streaming, sent as ephemeral messages (deleted when next tool starts)
- Text: Sent as Telegram messages, edited in-place with throttling (reuse `StreamingState` + `createStatusCallback()` pattern)
- Thinking: Brief inline indicator, same as current streaming
- User messages from desktop: Shown as `👤 <text>` so mobile user sees what the desktop user typed

**Guard rails:**

- Cannot watch a Telegram-sourced session (already controlled by the bot)
- Cannot watch while a query is running on the bot
- Auto-unwatch if session goes offline (with notification)

### Step 3: Takeover integration in text handler

**File:** `src/handlers/text.ts` (modify)

When a text message arrives and a watch is active for that chat:

1. Stop the tailer
2. Clear watch state
3. Send notification: "Taking over session..."
4. Load the desktop session via `session.loadFromRegistry()`
5. Set the watcher's active session to the watched session
6. Proceed with normal `sendMessageStreaming()` flow (which already handles `resume: sessionId`)

The desktop Claude process will fail on its next API call since the session is now owned by the bot. This is the intended behavior — the user has explicitly chosen to continue on mobile.

### Step 4: Resume on disconnect

**File:** `src/sessions/watcher.ts` (modify), `src/handlers/watch.ts` (modify)

When the session watcher detects a watched desktop session has gone offline:

1. Stop the tailer for that session
2. Send notification: "📴 Desktop session offline. Send a message to continue here."
3. Keep the session loaded in the bot's `ClaudeSession` (it already has the session ID)
4. Next message from the user resumes the session seamlessly

This requires exposing the watch state to the watcher's notification callback, done via a simple export from the watch module.

### Step 5: Wire up commands and update bot

**Files:** `src/bot.ts`, `src/handlers/index.ts`, `src/index.ts`

- Register `/watch` and `/unwatch` commands
- Add to autocomplete list
- Add to `/help` output
- Update `startWatcher` to notify watch handler on session removal

### Step 6: Update pinned status

**File:** `src/sessions/status-message.ts` (modify)

When watching, update pinned status to show:

```
👁 Watching: session-name | 🤖 Sonnet 4.6 | 🌿 main
```

When taking over:

```
✅ session-name | ⚡ Normal | 🤖 Sonnet 4.6 | 🌿 main
```

---

## File Change Summary

| File                             | Action  | Description                                            |
| -------------------------------- | ------- | ------------------------------------------------------ |
| `src/sessions/tailer.ts`         | **New** | JSONL file tailer for real-time session monitoring     |
| `src/handlers/watch.ts`          | **New** | `/watch` and `/unwatch` command handlers + watch state |
| `src/handlers/text.ts`           | Modify  | Detect active watch → takeover flow                    |
| `src/handlers/commands.ts`       | Modify  | Add `/watch` and `/unwatch` exports                    |
| `src/handlers/index.ts`          | Modify  | Export new handlers                                    |
| `src/bot.ts`                     | Modify  | Register `/watch` and `/unwatch` commands              |
| `src/index.ts`                   | Modify  | Wire watch handler into watcher notifications          |
| `src/sessions/status-message.ts` | Modify  | "Watching" status format                               |
| `src/sessions/index.ts`          | Modify  | Export tailer if needed                                |
| `src/sessions/watcher.ts`        | Modify  | Notify watch handler on session removal                |

---

## Tracer Bullet (Smallest End-to-End Slice)

Following the repo's own philosophy from `plans/prompt.md`:

**Build watch mode first.** Get a `/watch` command that tails a desktop session's JSONL and streams parsed events to Telegram. This validates:

- JSONL parsing works in real-time
- Event display is readable on mobile
- File watching is reliable

Then layer takeover (modify text handler) and resume (modify watcher notifications) on top, since they reuse existing `sendMessageStreaming()` infrastructure.

---

## Edge Cases & Considerations

1. **Multiple chats watching same session**: Support it — each chat gets its own `SessionTailer` instance. They're read-only so no conflicts.
2. **Large JSONL files**: Start tailing from current EOF, not from beginning. User can use `/history` (existing) for past context.
3. **Rapid tool calls**: Throttle tool status messages same as existing streaming (500ms). Delete previous tool message before sending new one.
4. **Desktop session restarts**: New JSONL file created. Tailer detects the old file stopped growing and the watcher picks up the new session. Auto-switch to new file.
5. **Bot restart while watching**: Watch state is in-memory only. After restart, user needs to `/watch` again. This is acceptable for v1.
6. **Takeover while desktop is mid-query**: The desktop query will fail when the bot resumes the session. The bot's message picks up from the last completed turn, which is correct.
