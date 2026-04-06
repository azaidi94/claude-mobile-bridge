# Design: /sessions and /resume Commands

**Date:** 2026-04-06  
**Status:** Approved

## Overview

Add two Telegram bot commands for browsing and resuming offline Claude sessions:

- `/sessions` — lists previous sessions (by project directory) that have no live relay
- Selecting a session shows **Resume / Cancel** inline buttons
- **Resume** spawns a cmux desktop session in that directory and auto-watches it

## Data Source

Claude stores session history as JSONL files at:

```
~/.claude/projects/<encoded-dir>/<session-uuid>.jsonl
```

The encoded dir is the working directory with `/` replaced by `-` (e.g. `/Users/azaidi/Projects/foo` → `-Users-azaidi-Projects-foo`).

**Offline session** = a project directory in `~/.claude/projects/` that:

1. Has at least one `.jsonl` file
2. Does NOT appear in `getRelayDirs()` (no live process)
3. The decoded working directory exists on disk (skip silently if not)

One entry per project directory, using the most recently modified JSONL file for the preview and timestamp.

## New File: `src/sessions/offline.ts`

```ts
export interface OfflineSession {
  dir: string; // working directory (read from JSONL cwd field)
  encodedDir: string; // ~/.claude/projects/<this>
  lastActivity: number; // mtime of newest JSONL (ms)
  lastMessage: string | null; // ~80 char preview from JSONL
}

export async function listOfflineSessions(): Promise<OfflineSession[]>;
```

Each JSONL entry includes a `cwd` field — no path decoding needed. Read `cwd` from the first line of the most recent JSONL file.

Steps:

1. Read `~/.claude/projects/` directory entries
2. For each entry, find the most recently modified `.jsonl` file
3. Read the first line of that JSONL and extract `cwd`
4. Skip if `cwd` directory doesn't exist on disk
5. Skip if `cwd` is in `getRelayDirs()` set (already a live session)
6. Read last message preview using existing `getLastSessionMessage()` from `sessions/tailer.ts`
7. Return sorted by `lastActivity` descending (most recent first), deduplicated by `cwd` (keep most recent per dir)

## In-Memory Cache

Telegram callback data has a 64-byte limit — directory paths are too long to embed.

A module-level map in `handlers/commands.ts`:

```ts
const offlineSessionCache = new Map<number, OfflineSession[]>(); // chatId → list
```

Populated when `/sessions` is called, referenced by index in callback data.

## Commands

### `handleSessions(ctx)` in `handlers/commands.ts`

1. Call `listOfflineSessions()`
2. If empty: reply "No offline sessions found."
3. Store result in `offlineSessionCache.set(chatId, sessions)`
4. Build message: one entry per session showing:
   - `📁 ~/Projects/foo`
   - Last activity: "3 days ago"
   - Last message snippet (if available)
5. Inline buttons: one row per session, `sess_pick:<idx>`, button text = dir basename

### Help text update

Add to `/help` under Sessions:

```
/sessions - Browse offline sessions
```

## Callback Handlers (in `handlers/callback.ts`)

### `sess_pick:<idx>`

1. Look up `offlineSessionCache.get(chatId)[idx]`
2. If not found: `answerCallbackQuery("Session list expired. Run /sessions again.")`
3. Edit the message to show the session details and two buttons:
   - `▶️ Resume` → `sess_resume:<idx>`
   - `✖ Cancel` → `sess_cancel`

### `sess_resume:<idx>`

1. Look up session from cache
2. Answer callback query immediately
3. Edit message to show "🚀 Spawning..."
4. Run the same cmux spawn logic as `handleNew`, using `session.dir` as `explicitPath`
5. On success: auto-watch (same as `/new`)
6. On failure: reply with error

The cmux spawn logic (currently inline in `handleNew`) should be extracted to a shared helper `spawnCmuxSession(ctx, chatId, explicitPath)` that both `handleNew` and the `sess_resume` callback can call.

### `sess_cancel`

Edit message to "✖ Cancelled." and answer callback.

## Bot Registration (`bot.ts`)

```ts
bot.command("sessions", handleSessions);
```

## Files Changed

| File                       | Change                                                                         |
| -------------------------- | ------------------------------------------------------------------------------ |
| `src/sessions/offline.ts`  | New — `listOfflineSessions()`                                                  |
| `src/handlers/commands.ts` | Add `handleSessions`, `offlineSessionCache`, extract `spawnCmuxSession` helper |
| `src/handlers/callback.ts` | Add `sess_pick`, `sess_resume`, `sess_cancel` handlers                         |
| `src/handlers/index.ts`    | Export `handleSessions`                                                        |
| `src/bot.ts`               | Register `/sessions` command                                                   |

## Error Handling

- `cmux` not installed → same message as `/new`
- Directory exists but spawn fails → relay error message
- Session cache expired (bot restarted between `/sessions` and button tap) → "Run /sessions again"
- Empty `~/.claude/projects/` or all dirs live/missing → "No offline sessions found."
