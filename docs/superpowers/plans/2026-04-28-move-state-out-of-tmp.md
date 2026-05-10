# Move Persistent State Out of /tmp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all persistent bot state and logs out of `/tmp` so macOS Tahoe's daily `com.apple.tmp_cleaner` (3-day TTL) stops reaping live data — most visibly the channel-relay port files, which silently disable Telegram delivery to long-lived Claude sessions.

**Architecture:** Existing convention is `~/.claude-mobile-bridge/` for state (already used by `settings.ts`, `topic-store.ts`) and macOS standard `~/Library/Logs/claude-mobile-bridge/` for logs. We add a small `src/paths.ts` module with side-effect-free constants so the channel-relay MCP server (which cannot import the side-effecting `config.ts`) can share the same paths without drift. Each state file gets the same one-time migration pattern as `topic-store.ts:59-76`: read primary; on miss, read legacy `/tmp` location and rewrite at the new path. `RESTART_FILE` and `TEMP_DIR` stay in `/tmp` — they're genuinely ephemeral.

**Tech Stack:** TypeScript, Bun, fs/promises. macOS-only deployment (launchd).

---

## File Structure

**New file:**

- `src/paths.ts` — pure path constants, no side effects (importable by MCP server)

**Modify:**

- `src/config.ts` — re-export from `paths.ts`, redirect `RELAY_PORT_FILE_PREFIX`/`SESSION_FILE`/`AUDIT_LOG_PATH`, add startup `mkdir` for new dirs
- `src/mcp/channel-relay/server.ts` — write port file under `STATE_DIR`
- `src/relay/discovery.ts` — read port files from `STATE_DIR`
- `src/sessions/watcher.ts` — chokidar watch `STATE_DIR`; migrate `ACTIVE_SESSION_FILE`
- `src/sessions/notifications.ts` — migrate `CHAT_IDS_FILE`
- `src/sessions/status-message.ts` — migrate `STATUS_FILE`
- `src/handlers/commands.ts` — change `/tmp/claude-bot.log` default
- `src/__tests__/plan-mode.test.ts` — update mocked path constants
- `src/__tests__/streaming.test.ts` — update mocked path constants
- `~/Library/LaunchAgents/com.azaidi.claude-bot.plist` — `StandardOutPath`/`StandardErrorPath`

**Leave alone:**

- `RESTART_FILE` (`/tmp/claude-telegram-restart.json`) — written and unlinked within seconds
- `TEMP_DIR` (`/tmp/telegram-bot`) — short-lived uploads/downloads
- `TEMP_PATHS` — security allowlist, not state
- `streaming.ts:286` `ask-user-*.json` glob — written by an external tool, out of scope

---

## Task 1: Path infrastructure + port-file move

This is the smoking-gun fix. One commit because the writer (MCP server), reader (discovery), and watcher (chokidar) all need to flip together — split commits would leave the bot blind to running relays in the gap.

**Files:**

- Create: `src/paths.ts`
- Modify: `src/config.ts:328`, `src/config.ts:359` (mkdir block at end of file)
- Modify: `src/mcp/channel-relay/server.ts:22-28`, `src/mcp/channel-relay/server.ts:31-41`
- Modify: `src/relay/discovery.ts:6-7`, `src/relay/discovery.ts:87-92`
- Modify: `src/sessions/watcher.ts:14-16`, `src/sessions/watcher.ts:691`

- [ ] **Step 1: Create `src/paths.ts`**

```ts
/**
 * Persistent state and log directories.
 *
 * Kept side-effect-free so the channel-relay MCP server (which runs in a
 * separate process inside a Claude session and cannot import the
 * env-mutating `config.ts`) can share the same paths.
 */

import { homedir } from "os";
import { join } from "path";

export const STATE_DIR =
  process.env.CLAUDE_TELEGRAM_STATE_DIR ??
  join(homedir(), ".claude-mobile-bridge");

export const LOG_DIR =
  process.env.CLAUDE_TELEGRAM_LOG_DIR ??
  join(homedir(), "Library", "Logs", "claude-mobile-bridge");
```

- [ ] **Step 2: Wire `STATE_DIR` into `config.ts`**

Edit `config.ts` — at the top with the other constant imports:

```ts
import { STATE_DIR, LOG_DIR } from "./paths";
export { STATE_DIR, LOG_DIR };
```

Replace line 328:

```ts
export const RELAY_PORT_FILE_PREFIX = join(STATE_DIR, "channel-relay-");
```

(`join` is already imported at the top of the file via the `path` import on line 8 — `resolve, dirname` — add `join` to that import.)

At the bottom of the file (after the existing `await mkdir(TEMP_DIR, { recursive: true })` on line 359), add:

```ts
await mkdir(STATE_DIR, { recursive: true });
await mkdir(LOG_DIR, { recursive: true });
```

- [ ] **Step 3: Update `server.ts` to write under `STATE_DIR`**

Replace lines 22-28 of `src/mcp/channel-relay/server.ts`:

```ts
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { STATE_DIR } from "../../paths";

// ── Port file ──────────────────────────────────────────────────────────

const cwd = process.cwd();
const dirHash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
const PORT_FILE = join(
  STATE_DIR,
  `channel-relay-${dirHash}-${process.pid}.json`,
);
const parentSessionId = getParentClaudeSessionId();
```

Replace `writePortFile` (lines 31-41) so it ensures the dir exists before writing:

```ts
function writePortFile(port: number): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const data = {
    port,
    pid: process.pid,
    ppid: process.ppid,
    sessionId: parentSessionId,
    cwd,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(PORT_FILE, JSON.stringify(data, null, 2));
}
```

- [ ] **Step 4: Update `discovery.ts` to read from `STATE_DIR`**

Replace lines 6-7 of `src/relay/discovery.ts` to add the import:

```ts
import { readFile, readdir, unlink } from "fs/promises";
import { join } from "path";
import { execSync } from "child_process";
import { createHash } from "crypto";
import { RelayClient } from "./client";
import { RELAY_CONNECT_TIMEOUT_MS } from "../config";
import { STATE_DIR } from "../paths";
import { debug, info, warn } from "../logger";
```

Replace lines 87-92 inside `scanPortFiles`:

```ts
    const files = await readdir(STATE_DIR);
    for (const file of files) {
      if (!file.startsWith("channel-relay-") || !file.endsWith(".json"))
        continue;
      try {
        const filePath = join(STATE_DIR, file);
        const content = await readFile(filePath, "utf-8");
```

Update the comment on line 3:

```ts
 * STATE_DIR/channel-relay-*.json port files. Validates PID and caches clients.
```

- [ ] **Step 5: Update watcher's chokidar path**

Add to imports near line 14-16 of `src/sessions/watcher.ts`:

```ts
import { STATE_DIR } from "../paths";
```

Replace line 689-691:

```ts
  // Watch STATE_DIR for relay port file creation/deletion
  try {
    relayWatcher = watch(STATE_DIR, (event, filename) => {
```

- [ ] **Step 6: Typecheck and run relay tests**

```bash
bun run typecheck
bun test src/__tests__/streaming.test.ts src/__tests__/session-manager.test.ts src/__tests__/plan-mode.test.ts
```

Expected: typecheck passes. Tests may fail due to mocked `RELAY_PORT_FILE_PREFIX` still pointing at `/tmp` — that gets fixed in Task 9. If they fail with `STATE_DIR is not defined` or similar import error, that's a real bug to fix.

- [ ] **Step 7: Commit**

```bash
git add src/paths.ts src/config.ts src/mcp/channel-relay/server.ts src/relay/discovery.ts src/sessions/watcher.ts
git commit -m "fix(relay): move port files out of /tmp to ~/.claude-mobile-bridge

macOS Tahoe's com.apple.tmp_cleaner reaps /tmp files older than ~3 days,
silently orphaning live channel-relay port files. Long-lived Claude
sessions then become unreachable from Telegram even though the relay
process is still running.

Move port files to STATE_DIR (~/.claude-mobile-bridge/), which is not
auto-reaped. Add side-effect-free src/paths.ts so the MCP server can
share the constant without pulling in env-mutating config.ts."
```

---

## Task 2: Migrate `SESSION_FILE` to `STATE_DIR`

**Files:**

- Modify: `src/config.ts:351`
- Modify: callers of `SESSION_FILE` (find via grep first)

- [ ] **Step 1: Find all readers/writers of `SESSION_FILE`**

```bash
grep -rn "SESSION_FILE" src/ --include='*.ts' | grep -v __tests__
```

- [ ] **Step 2: Update `config.ts:351`**

```ts
export const SESSION_FILE = join(STATE_DIR, "session.json");
```

- [ ] **Step 3: Add legacy-fallback read at every load site**

For each file that reads `SESSION_FILE` via `readFile(SESSION_FILE)`, wrap with a one-time migration. Pattern (modeled on `topic-store.ts:45-77`):

```ts
import { join } from "path";
import { tmpdir } from "os";
import { SESSION_FILE } from "../config";

const LEGACY_SESSION_FILE = "/tmp/claude-telegram-session.json";

async function loadSession(): Promise<SessionState | null> {
  try {
    const data = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    // fall through to legacy
  }
  try {
    const data = await readFile(LEGACY_SESSION_FILE, "utf-8");
    const parsed = JSON.parse(data);
    await writeFile(SESSION_FILE, JSON.stringify(parsed, null, 2));
    info(`session: migrated from ${LEGACY_SESSION_FILE} to ${SESSION_FILE}`);
    return parsed;
  } catch {
    return null;
  }
}
```

Apply this only to the actual `loadSession` function (or equivalent). Writers don't need migration logic — they just write to the new path.

- [ ] **Step 4: Run tests**

```bash
bun run typecheck && bun test
```

- [ ] **Step 5: Commit**

```bash
git commit -m "fix: move SESSION_FILE to ~/.claude-mobile-bridge with one-time migration"
```

---

## Task 3: Migrate `CHAT_IDS_FILE` (`notifications.ts`)

**Files:**

- Modify: `src/sessions/notifications.ts:8-17`

- [ ] **Step 1: Replace path and add legacy fallback**

In `src/sessions/notifications.ts`, replace lines 8-17:

```ts
import { readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { InlineKeyboard, type Api } from "grammy";
import type { SessionInfo } from "./types";
import { info, warn } from "../logger";
import { getActiveSession } from "./watcher";
import type { TopicManager } from "../topics";
import { STATE_DIR } from "../paths";

const CHAT_IDS_FILE = join(STATE_DIR, "chat-ids.json");
const LEGACY_CHAT_IDS_FILE = join(tmpdir(), "claude-telegram-chat-ids.json");
```

- [ ] **Step 2: Add legacy fallback to load function**

Find the function that reads `CHAT_IDS_FILE` (likely `loadChatIds` or similar — grep `CHAT_IDS_FILE` within the file). Add the same fallback pattern as Task 2 Step 3. Save logic doesn't change — it always writes to `CHAT_IDS_FILE`.

- [ ] **Step 3: Verify**

```bash
bun run typecheck
bun test src/__tests__/  # whichever tests touch notifications
```

- [ ] **Step 4: Commit**

```bash
git commit -m "fix: move chat-ids state to ~/.claude-mobile-bridge with one-time migration"
```

---

## Task 4: Migrate `ACTIVE_SESSION_FILE` (`watcher.ts`)

**Files:**

- Modify: `src/sessions/watcher.ts:21-24`, `src/sessions/watcher.ts:67-71`

- [ ] **Step 1: Replace path and add legacy fallback**

Replace lines 21-24:

```ts
const ACTIVE_SESSION_FILE = join(STATE_DIR, "active-session.txt");
const LEGACY_ACTIVE_SESSION_FILE = join(
  tmpdir(),
  "claude-telegram-active-session.txt",
);
```

(`STATE_DIR` already imported in Task 1; `tmpdir` already imported on line 9; `join` already imported on line 8.)

- [ ] **Step 2: Add legacy fallback to `loadActiveSession`**

Replace `loadActiveSession` (currently lines 67-71, ending around line 73):

```ts
async function loadActiveSession(): Promise<string | null> {
  try {
    const name = await readFile(ACTIVE_SESSION_FILE, "utf-8");
    return name.trim() || null;
  } catch {
    // fall through to legacy
  }
  try {
    const name = await readFile(LEGACY_ACTIVE_SESSION_FILE, "utf-8");
    const trimmed = name.trim();
    if (trimmed) {
      await writeFile(ACTIVE_SESSION_FILE, trimmed, "utf-8");
      info(
        `watcher: migrated active session from ${LEGACY_ACTIVE_SESSION_FILE} to ${ACTIVE_SESSION_FILE}`,
      );
    }
    return trimmed || null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Verify**

```bash
bun run typecheck
bun test
```

- [ ] **Step 4: Commit**

```bash
git commit -m "fix: move active-session state to ~/.claude-mobile-bridge with one-time migration"
```

---

## Task 5: Migrate `STATUS_FILE` (`status-message.ts`)

**Files:**

- Modify: `src/sessions/status-message.ts:8-33`, `loadPinnedMessageIds` function

- [ ] **Step 1: Replace path and add legacy fallback**

Replace lines 8-10 to add the path import:

```ts
import { readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Api } from "grammy";
import { info, warn, debug } from "../logger";
import { getEnablePinnedStatus } from "../settings";
import { STATE_DIR } from "../paths";
```

Replace line 33:

```ts
const STATUS_FILE = join(STATE_DIR, "pinned-messages.json");
const LEGACY_STATUS_FILE = join(
  tmpdir(),
  "claude-telegram-pinned-messages.json",
);
```

- [ ] **Step 2: Add legacy fallback to `loadPinnedMessageIds`**

Replace the function (currently lines 45-56):

```ts
export async function loadPinnedMessageIds(): Promise<void> {
  let parsed: Record<string, number> | null = null;
  let migrated = false;
  try {
    const data = await readFile(STATUS_FILE, "utf-8");
    parsed = JSON.parse(data);
  } catch {
    try {
      const data = await readFile(LEGACY_STATUS_FILE, "utf-8");
      parsed = JSON.parse(data);
      migrated = true;
    } catch {
      // No file
    }
  }
  if (!parsed) return;
  for (const [k, v] of Object.entries(parsed)) {
    pinnedMessageIds.set(k, v);
  }
  if (migrated) {
    await writeFile(STATUS_FILE, JSON.stringify(parsed, null, 2)).catch(
      () => {},
    );
    info(
      `status: migrated ${pinnedMessageIds.size} pinned msg(s) from ${LEGACY_STATUS_FILE} to ${STATUS_FILE}`,
    );
  } else {
    debug(`status: loaded ${pinnedMessageIds.size} pinned msg(s)`);
  }
}
```

- [ ] **Step 3: Verify**

```bash
bun run typecheck
bun test
```

- [ ] **Step 4: Commit**

```bash
git commit -m "fix: move pinned-status state to ~/.claude-mobile-bridge with one-time migration"
```

---

## Task 6: Move audit log to `LOG_DIR`

**Files:**

- Modify: `src/config.ts:277-278`

- [ ] **Step 1: Update default**

Replace lines 277-278:

```ts
export const AUDIT_LOG_PATH =
  process.env.AUDIT_LOG_PATH || join(LOG_DIR, "audit.log");
```

(LOG_DIR is already in scope from Task 1's import.)

No migration needed — the audit log is append-only with mtime updated on every request, and the new file just starts fresh. The user can manually move the old `/tmp/claude-telegram-audit.log` into `~/Library/Logs/claude-mobile-bridge/` if they want to preserve history; otherwise tmp_cleaner will reap it within ~3 days of inactivity.

- [ ] **Step 2: Verify**

```bash
bun run typecheck && bun test
```

- [ ] **Step 3: Commit**

```bash
git commit -m "fix: move audit log to ~/Library/Logs/claude-mobile-bridge by default"
```

---

## Task 7: Move launchd-managed bot.log + update default

**Files:**

- Modify: `src/handlers/commands.ts:1464`
- Modify: `~/Library/LaunchAgents/com.azaidi.claude-bot.plist`

This step requires a launchd reload, which momentarily stops the bot. Do this last so all the in-tree changes are committed first.

- [ ] **Step 1: Update the in-code default**

Edit `src/handlers/commands.ts:1464`:

```ts
const logPath =
  process.env.CLEANZOMBIE_LOG_PATH ||
  join(homedir(), "Library", "Logs", "claude-mobile-bridge", "bot.log");
```

(Add `homedir` and `join` imports at the top of `commands.ts` if not already present.)

- [ ] **Step 2: Update the launchd plist**

Edit `~/Library/LaunchAgents/com.azaidi.claude-bot.plist`:

```xml
    <key>StandardOutPath</key>
    <string>/Users/&lt;you&gt;/Library/Logs/claude-mobile-bridge/bot.log</string>

    <key>StandardErrorPath</key>
    <string>/Users/&lt;you&gt;/Library/Logs/claude-mobile-bridge/bot.log</string>
```

(launchd does not expand `~`, so the absolute path is required — substitute your actual home dir.)

- [ ] **Step 3: Ensure log dir exists (launchd will not create it)**

```bash
mkdir -p ~/Library/Logs/claude-mobile-bridge
```

- [ ] **Step 4: Reload launchd**

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.azaidi.claude-bot.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.azaidi.claude-bot.plist
```

Verify:

```bash
launchctl list | grep com.azaidi.claude-bot
ls -la ~/Library/Logs/claude-mobile-bridge/bot.log
```

Expected: bot listed with non-zero PID, new log file is being written.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/commands.ts
git commit -m "fix: default bot.log path to ~/Library/Logs/claude-mobile-bridge"
```

(The plist isn't checked into the repo, so it's not part of the commit.)

---

## Task 8: Update test mocks

**Files:**

- Modify: `src/__tests__/plan-mode.test.ts:45`
- Modify: `src/__tests__/streaming.test.ts:44`

The mocks redefine the entire `../config` module. With the new `RELAY_PORT_FILE_PREFIX` constructed from `STATE_DIR` at import time, the mocks must either provide a real (tmp) state dir or hardcode the prefix to a tmpdir-scoped value. Hardcoding to `/tmp/channel-relay-` is fine for these tests because the test itself isolates the prefix; we just need to keep using a reaper-safe value (`os.tmpdir()` is already in /tmp on macOS — but tests are short-lived, so this is acceptable).

- [ ] **Step 1: Update both test files**

In each file, replace the `RELAY_PORT_FILE_PREFIX` mock value with a per-test-isolated path:

```ts
RELAY_PORT_FILE_PREFIX: join(tmpdir(), `channel-relay-test-${process.pid}-`),
```

Add to imports at top of test:

```ts
import { tmpdir } from "os";
import { join } from "path";
```

If `STATE_DIR` is referenced anywhere in the mocked exports list (it isn't yet — verify), add it:

```ts
STATE_DIR: tmpdir(),
LOG_DIR: tmpdir(),
```

- [ ] **Step 2: Run the affected tests**

```bash
bun test src/__tests__/plan-mode.test.ts src/__tests__/streaming.test.ts
```

Expected: pass.

- [ ] **Step 3: Run full test suite**

```bash
bun test
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git commit -m "test: isolate relay port-file prefix per test process"
```

---

## Task 9: Deploy and verify

This is the manual verification step — no code changes.

- [ ] **Step 1: Restart the bot**

The Task 7 launchctl reload already restarted it. Verify:

```bash
tail -50 ~/Library/Logs/claude-mobile-bridge/bot.log
```

Expected: see `bot: @AHZ_CB_bot ready` line near the end. No "no exact match for session" warnings for sessions that have just had their relays restarted.

- [ ] **Step 2: Restart each running claude relay session**

Every currently-running `claude --dangerously-load-development-channels server:channel-relay …` process has the OLD code paths baked in and is still writing port files to `/tmp` (or has had them reaped). They need to be restarted.

Identify them:

```bash
ps -eo pid,lstart,command | grep "channel-relay" | grep -v grep
```

For each relay session listed, go to the terminal hosting it and start a new Claude session (or `/exit` and restart). After restart, verify a port file appears in `~/.claude-mobile-bridge/` for that session:

```bash
ls -la ~/.claude-mobile-bridge/channel-relay-*.json
```

- [ ] **Step 3: Smoke-test Telegram delivery**

Send a message to the saas-builder topic in Telegram. Expected: message reaches the desktop Claude session; no `❌ Relay failed` reply.

- [ ] **Step 4: Verify migrations actually ran**

Check the logs for migration lines:

```bash
grep -E "(migrated|migration)" ~/Library/Logs/claude-mobile-bridge/bot.log | head
```

Expected (if there was anything in /tmp to migrate): one line per migrated file, e.g.

```
status: migrated 3 pinned msg(s) from /tmp/... to ~/.claude-mobile-bridge/...
```

- [ ] **Step 5: Confirm /tmp is now lean**

```bash
ls /tmp/claude-telegram-* /tmp/channel-relay-* 2>&1
```

Expected: no relay/state files (or only stragglers from yet-to-be-restarted sessions). `RESTART_FILE` only appears momentarily during a restart.

---

## Self-review notes

- **Spec coverage:** All 6 persistent state files moved (port files, SESSION, CHAT_IDS, ACTIVE_SESSION, STATUS, plus `topics.json`/`settings.json` already there); 2 logs moved (audit, bot.log); `RESTART_FILE` and `TEMP_DIR` deliberately left in `/tmp`. Each move has a one-time migration except logs (where migration is unnecessary).
- **No drift:** `paths.ts` is the single source of truth for `STATE_DIR`/`LOG_DIR`; `config.ts` re-exports it; `server.ts` imports it directly to avoid pulling in the side-effecting `config.ts`.
- **Reaper-safety check:** New locations (`~/.claude-mobile-bridge/` and `~/Library/Logs/`) are user-home directories. macOS `tmp_cleaner` only targets `/tmp`. Confirmed via `/System/Library/LaunchDaemons/com.apple.tmp_cleaner.plist`.
- **Migration risk:** Each load site uses the `topic-store.ts:45-77` pattern, which is proven in production. Failure at the migration step degrades gracefully to "no prior state" — same as the first-run experience.
- **Test mock alignment:** `plan-mode.test.ts:45` and `streaming.test.ts:44` are the only test mocks that reference `/tmp/channel-relay-`; both updated in Task 8.
