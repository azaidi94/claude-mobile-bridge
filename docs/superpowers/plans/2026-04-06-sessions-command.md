# /sessions Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/sessions` command that lists offline Claude sessions and lets users resume them as cmux desktop sessions via inline buttons.

**Architecture:** New `src/sessions/offline.ts` scans `~/.claude/projects/`, reads `cwd` from JSONL entries, and filters out live sessions. `handleSessions` displays the list with index-keyed inline buttons; callback handlers manage `pick → confirm → spawn` using an in-memory cache (Telegram has a 64-byte callback data limit, so paths can't be embedded directly). The cmux spawn logic is extracted from `handleNew` into a shared `spawnCmuxSession` helper.

**Tech Stack:** Bun, grammY, TypeScript, cmux CLI

---

## File Map

| File                            | Action     | Responsibility                                                                           |
| ------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `src/sessions/offline.ts`       | **Create** | `listOfflineSessions()` — scan JSONL history, filter live sessions                       |
| `src/handlers/commands.ts`      | **Modify** | Add `handleSessions`, `offlineSessionCache`; extract `spawnCmuxSession` from `handleNew` |
| `src/handlers/callback.ts`      | **Modify** | Add `sess_pick`, `sess_resume`, `sess_cancel` callback handlers                          |
| `src/handlers/index.ts`         | **Modify** | Export `handleSessions` and `offlineSessionCache`                                        |
| `src/bot.ts`                    | **Modify** | Register `bot.command("sessions", handleSessions)`                                       |
| `src/__tests__/offline.test.ts` | **Create** | Tests for `listOfflineSessions`                                                          |

---

## Task 1: `src/sessions/offline.ts` — list offline sessions

**Files:**

- Create: `src/sessions/offline.ts`
- Create: `src/__tests__/offline.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Create `src/__tests__/offline.test.ts`:

```typescript
/**
 * Unit tests for listOfflineSessions().
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// We'll test the helper functions by pointing them at temp dirs.
// listOfflineSessions reads PROJECTS_DIR from a module-level const, so we
// test the lower-level helpers directly via re-exports.
import { findNewestJsonlInDir, readCwdFromJsonl } from "../sessions/offline";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "offline-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("findNewestJsonlInDir", () => {
  test("returns null for empty directory", async () => {
    const result = await findNewestJsonlInDir(tmpDir);
    expect(result).toBeNull();
  });

  test("returns null for directory with no jsonl files", async () => {
    await writeFile(join(tmpDir, "foo.txt"), "hello");
    const result = await findNewestJsonlInDir(tmpDir);
    expect(result).toBeNull();
  });

  test("returns the single jsonl file", async () => {
    await writeFile(join(tmpDir, "abc.jsonl"), "{}");
    const result = await findNewestJsonlInDir(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.path).toContain("abc.jsonl");
  });

  test("returns the most recently modified jsonl", async () => {
    // Write two files; the second one is "newer" by modification order
    await writeFile(join(tmpDir, "old.jsonl"), '{"ts":1}');
    await Bun.sleep(10);
    await writeFile(join(tmpDir, "new.jsonl"), '{"ts":2}');
    const result = await findNewestJsonlInDir(tmpDir);
    expect(result!.path).toContain("new.jsonl");
  });
});

describe("readCwdFromJsonl", () => {
  test("returns null for empty file", async () => {
    const p = join(tmpDir, "empty.jsonl");
    await writeFile(p, "");
    expect(await readCwdFromJsonl(p)).toBeNull();
  });

  test("returns null when first line has no cwd field", async () => {
    const p = join(tmpDir, "nocwd.jsonl");
    await writeFile(p, '{"type":"user","message":"hi"}\n');
    expect(await readCwdFromJsonl(p)).toBeNull();
  });

  test("returns cwd from first line", async () => {
    const p = join(tmpDir, "has-cwd.jsonl");
    await writeFile(
      p,
      '{"type":"progress","cwd":"/Users/test/myproject"}\n{"type":"user"}\n',
    );
    expect(await readCwdFromJsonl(p)).toBe("/Users/test/myproject");
  });

  test("returns null for non-existent file", async () => {
    expect(await readCwdFromJsonl("/nonexistent/path.jsonl")).toBeNull();
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

```bash
bun test src/__tests__/offline.test.ts
```

Expected: `error: Cannot find module '../sessions/offline'`

- [ ] **Step 1.3: Implement `src/sessions/offline.ts`**

```typescript
/**
 * Lists offline Claude sessions from ~/.claude/projects/.
 *
 * An "offline" session is a project directory with JSONL history
 * but no live relay process. Returns one entry per working directory,
 * sorted most-recent-first.
 */

import { readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { getRelayDirs } from "../relay";
import { getLastSessionMessage } from "./tailer";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface OfflineSession {
  /** Decoded working directory (read from JSONL cwd field). */
  dir: string;
  /** Entry name under ~/.claude/projects/ */
  encodedDir: string;
  /** mtime of the newest JSONL file (ms). */
  lastActivity: number;
  /** ~80-char preview of last user or assistant message. */
  lastMessage: string | null;
}

/**
 * Find the most recently modified .jsonl file in a project directory.
 * Exported for unit testing.
 */
export async function findNewestJsonlInDir(
  projectDir: string,
): Promise<{ path: string; mtime: number } | null> {
  let best: { path: string; mtime: number } | null = null;
  try {
    const files = await readdir(projectDir);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(projectDir, file);
      const s = await stat(filePath).catch(() => null);
      if (!s?.isFile()) continue;
      const mtime = s.mtime.getTime();
      if (!best || mtime > best.mtime) {
        best = { path: filePath, mtime };
      }
    }
  } catch {
    // Directory unreadable — skip
  }
  return best;
}

/**
 * Read the `cwd` field from the first line of a JSONL file.
 * Exported for unit testing.
 */
export async function readCwdFromJsonl(
  filePath: string,
): Promise<string | null> {
  try {
    const { readFile } = await import("fs/promises");
    const text = await readFile(filePath, "utf-8");
    const firstLine = text.split("\n")[0];
    if (!firstLine) return null;
    const entry = JSON.parse(firstLine);
    return typeof entry.cwd === "string" ? entry.cwd : null;
  } catch {
    return null;
  }
}

/**
 * List offline Claude sessions — one per working directory, most recent first.
 *
 * Filters out:
 * - Directories with a live relay (already shown in /list)
 * - Working directories that no longer exist on disk
 */
export async function listOfflineSessions(): Promise<OfflineSession[]> {
  const [liveRelayDirs, projectEntries] = await Promise.all([
    getRelayDirs(),
    readdir(PROJECTS_DIR).catch((): string[] => []),
  ]);

  const liveSet = new Set(liveRelayDirs);
  const seenDirs = new Set<string>();
  const results: OfflineSession[] = [];

  await Promise.all(
    projectEntries.map(async (entry) => {
      if (entry.startsWith(".")) return;

      const projectDir = join(PROJECTS_DIR, entry);
      const newest = await findNewestJsonlInDir(projectDir);
      if (!newest) return;

      const cwd = await readCwdFromJsonl(newest.path);
      if (!cwd) return;

      // Deduplicate by working directory
      if (seenDirs.has(cwd)) return;
      seenDirs.add(cwd);

      // Skip live sessions
      if (liveSet.has(cwd)) return;

      // Skip directories that no longer exist on disk
      const dirStat = await stat(cwd).catch(() => null);
      if (!dirStat?.isDirectory()) return;

      const lastMsgResult = await getLastSessionMessage(newest.path, 80);

      results.push({
        dir: cwd,
        encodedDir: entry,
        lastActivity: newest.mtime,
        lastMessage: lastMsgResult?.text ?? null,
      });
    }),
  );

  return results.sort((a, b) => b.lastActivity - a.lastActivity);
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

```bash
bun test src/__tests__/offline.test.ts
```

Expected: all 8 tests pass.

- [ ] **Step 1.5: Run full test suite to check nothing broke**

```bash
bun run test
```

Expected: all tests pass.

- [ ] **Step 1.6: Commit**

```bash
git add src/sessions/offline.ts src/__tests__/offline.test.ts
git commit -m "feat: add listOfflineSessions() to scan ~/.claude/projects"
```

---

## Task 2: Extract `spawnCmuxSession` and add `handleSessions`

**Files:**

- Modify: `src/handlers/commands.ts`

The cmux spawn body inside `handleNew` (the `try { const beforeRelays = ...` block through to the end) is extracted into `spawnCmuxSession`. Both `handleNew` and the future resume callback use it.

- [ ] **Step 2.1: Add `offlineSessionCache` and `spawnCmuxSession` to `commands.ts`**

Add the following **after the imports** in `src/handlers/commands.ts`:

```typescript
import type { OfflineSession } from "../sessions/offline";
import { listOfflineSessions } from "../sessions/offline";

/** In-memory cache of offline session lists, keyed by chatId.
 *  Populated by handleSessions; consumed by sess_pick / sess_resume callbacks.
 *  Keyed by chatId so multiple users each get their own list.
 */
export const offlineSessionCache = new Map<number, OfflineSession[]>();
```

- [ ] **Step 2.2: Extract `spawnCmuxSession` helper**

In `src/handlers/commands.ts`, add the following new function **before** `handleNew`. Then replace the entire `try { const beforeRelays = ...` block in `handleNew` with a call to this helper.

```typescript
/**
 * Core cmux spawn logic — shared by /new command and sess_resume callback.
 *
 * Spawns a new cmux workspace in `explicitPath`, waits for the relay to come
 * online, identifies the new session, sets it as active, and starts watching.
 * All status messages are sent via `api.sendMessage(chatId, text)`.
 */
export async function spawnCmuxSession(
  api: Context["api"],
  chatId: number,
  explicitPath: string,
  userId: number,
): Promise<void> {
  const opId = createOpId("spawn");
  const spawnStartedAt = Date.now();
  info("spawn: started", { opId, chatId, userId, explicitPath });

  try {
    const beforeRelays = (await scanPortFiles(true)).filter(
      (pf) => pf.cwd === explicitPath,
    );
    const knownRelayIds = new Set(beforeRelays.map(relayIdentity));
    const beforeSessions = getSessions().filter((s) => s.dir === explicitPath);
    const knownSessionIds = new Set(
      beforeSessions.map((s) => s.id).filter(Boolean),
    );
    const knownSessionPids = new Set(
      beforeSessions
        .map((s) => s.pid)
        .filter((pid): pid is number => pid !== undefined),
    );

    const wsResult = Bun.spawnSync([
      "cmux",
      "new-workspace",
      "--cwd",
      explicitPath,
    ]);
    const wsOutput = wsResult.stdout.toString().trim();
    const wsMatch = wsOutput.match(/workspace:(\d+)/);
    if (!wsMatch) {
      warn("spawn: failed to create workspace", {
        opId,
        chatId,
        userId,
        explicitPath,
        durationMs: elapsedMs(spawnStartedAt),
      });
      await api.sendMessage(chatId, "❌ Failed to create cmux workspace.");
      return;
    }
    const workspaceId = `workspace:${wsMatch[1]}`;

    await Bun.sleep(1000);
    Bun.spawnSync(["cmux", "send", "--workspace", workspaceId, "cc\n"]);

    // Accept dev channels prompt
    await Bun.sleep(5000);
    Bun.spawnSync(["cmux", "send-key", "--workspace", workspaceId, "Enter"]);

    await api.sendMessage(chatId, "⏳ Waiting for Claude to start...");

    const deadline = Date.now() + 20_000;
    let spawnedRelay: Awaited<ReturnType<typeof scanPortFiles>>[number] | null =
      null;
    while (Date.now() < deadline) {
      await Bun.sleep(2000);
      const portFiles = await scanPortFiles(true);
      const newRelays = portFiles.filter(
        (pf) =>
          pf.cwd === explicitPath && !knownRelayIds.has(relayIdentity(pf)),
      );
      if (newRelays.length > 1) {
        warn("spawn: ambiguous new relays", {
          opId,
          chatId,
          userId,
          explicitPath,
          durationMs: elapsedMs(spawnStartedAt),
          candidateCount: newRelays.length,
        });
        await api.sendMessage(
          chatId,
          "⚠️ Session spawned, but multiple new relays appeared.\n" +
            "Use /list to pick the right session.",
        );
        return;
      }
      if (newRelays.length === 1) {
        spawnedRelay = newRelays[0]!;
        break;
      }
    }

    if (!spawnedRelay) {
      warn("spawn: relay not detected", {
        opId,
        chatId,
        userId,
        explicitPath,
        durationMs: elapsedMs(spawnStartedAt),
      });
      await api.sendMessage(
        chatId,
        "⚠️ Session spawned but relay not detected yet. Check cmux and try /list.",
      );
      return;
    }

    await forceRefresh();
    const sessions = getSessions();
    const dirSessions = sessions.filter((s) => s.dir === explicitPath);
    let spawned =
      (spawnedRelay.sessionId
        ? dirSessions.find((s) => s.id === spawnedRelay?.sessionId)
        : undefined) ||
      (spawnedRelay.ppid !== undefined
        ? dirSessions.find((s) => s.pid === spawnedRelay?.ppid)
        : undefined);

    if (!spawned) {
      const newCandidates = dirSessions.filter(
        (s) =>
          (Boolean(s.id) && !knownSessionIds.has(s.id)) ||
          (s.pid !== undefined && !knownSessionPids.has(s.pid)),
      );
      if (newCandidates.length === 1) {
        spawned = newCandidates[0]!;
      }
    }

    if (!spawned && beforeSessions.length === 0 && dirSessions.length === 1) {
      spawned = dirSessions[0]!;
    }

    if (spawned) {
      setActiveSession(spawned.name);
      startWatchingSession(api, chatId, spawned.name, "spawn").catch(() => {});
      info("spawn: completed", {
        opId,
        chatId,
        userId,
        explicitPath,
        sessionName: spawned.name,
        sessionId: spawned.id,
        durationMs: elapsedMs(spawnStartedAt),
      });
    } else {
      warn("spawn: session unresolved after relay detection", {
        opId,
        chatId,
        userId,
        explicitPath,
        durationMs: elapsedMs(spawnStartedAt),
      });
      await api.sendMessage(
        chatId,
        "⚠️ Session spawned, but could not uniquely identify the new session.\n" +
          "Use /list to find it.",
      );
    }
  } catch (err) {
    logError("spawn: failed", err, {
      chatId,
      userId,
      explicitPath,
      durationMs: elapsedMs(spawnStartedAt),
    });
    await api.sendMessage(
      chatId,
      `❌ Spawn failed: ${String(err).slice(0, 200)}`,
    );
  }
}
```

- [ ] **Step 2.3: Refactor `handleNew` to use `spawnCmuxSession`**

Replace the entire `try { const beforeRelays = ...` block at the end of `handleNew` (lines ~191–345) with:

```typescript
await spawnCmuxSession(ctx.api, chatId, explicitPath, userId!);
```

The `handleNew` function now ends like this after the directory validation:

```typescript
  const dir = explicitPath.replace(/^\/Users\/[^/]+/, "~");
  await ctx.reply(
    `🚀 Spawning desktop session...\n📁 <code>${escapeHtml(dir)}</code>`,
    { parse_mode: "HTML" },
  );

  await spawnCmuxSession(ctx.api, chatId, explicitPath, userId!);
}
```

Also remove the now-unused `opId` and `spawnStartedAt` locals that were only used inside the extracted block.

- [ ] **Step 2.4: Add `handleSessions` command**

Add at the end of the "Session Commands" section in `src/handlers/commands.ts`:

```typescript
/**
 * /sessions - List offline Claude sessions with Resume buttons.
 */
export async function handleSessions(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (!chatId) return;

  if (!Bun.which("cmux")) {
    await ctx.reply(
      "❌ <b>cmux required</b>\n\n" +
        "<code>/sessions</code> resumes sessions via cmux.\n" +
        'Install from: <a href="https://cmux.dev">cmux.dev</a>',
      { parse_mode: "HTML" },
    );
    return;
  }

  const sessions = await listOfflineSessions();

  if (sessions.length === 0) {
    await ctx.reply(
      "📋 No offline sessions found.\n\nAll sessions are either live or have no history.",
    );
    return;
  }

  // Cache for callback handlers
  offlineSessionCache.set(chatId, sessions);

  const lines: string[] = ["📋 <b>Offline Sessions</b>\n"];

  for (const s of sessions) {
    const dir = s.dir.replace(/^\/Users\/[^/]+/, "~");
    const ago = formatTimeAgo(s.lastActivity);
    lines.push(`📁 <code>${escapeHtml(dir)}</code> · ${ago}`);
    if (s.lastMessage) {
      lines.push(`   <i>${escapeHtml(s.lastMessage)}</i>`);
    }
    lines.push("");
  }

  const buttons = sessions.map((s, i) => [
    {
      text: s.dir.split("/").pop() || s.dir,
      callback_data: `sess_pick:${i}`,
    },
  ]);

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });
}
```

- [ ] **Step 2.5: Update `/help` to include `/sessions`**

In `handleHelp`, find the Sessions section and add the new command:

```typescript
      `<b>Sessions:</b>\n` +
      `/list - Show all sessions\n` +
      `/switch &lt;name&gt; - Switch to session\n` +
      `/sessions - Browse offline sessions\n` +
      `/new [path] - Spawn desktop session (cmux)\n\n` +
```

- [ ] **Step 2.6: Run the existing test suite**

```bash
bun run test
```

Expected: all tests pass (the refactored `handleNew` should still pass its existing tests in `commands.test.ts`).

- [ ] **Step 2.7: Commit**

```bash
git add src/handlers/commands.ts src/sessions/offline.ts
git commit -m "feat: add handleSessions and extract spawnCmuxSession helper"
```

---

## Task 3: Callback handlers for session pick / resume / cancel

**Files:**

- Modify: `src/handlers/callback.ts`

Telegram callback data limit is 64 bytes. `sess_pick:0` and `sess_resume:0` (index-based) stay well under the limit.

- [ ] **Step 3.1: Add `sess_pick`, `sess_resume`, `sess_cancel` handlers in `callback.ts`**

Add the following imports at the top of `src/handlers/callback.ts`:

```typescript
import { offlineSessionCache, spawnCmuxSession } from "./commands";
```

Then add the three new callback sections **before** the final `askuser:` block (place them after the `kill:` handler, around line 200):

```typescript
// 5. Handle offline session pick: sess_pick:{idx}
if (callbackData.startsWith("sess_pick:")) {
  const idx = parseInt(callbackData.slice(10), 10);
  const sessions = offlineSessionCache.get(chatId);
  const s = sessions?.[idx];

  if (!s) {
    await ctx.answerCallbackQuery({
      text: "Session list expired. Run /sessions again.",
    });
    return;
  }

  const dir = s.dir.replace(/^\/Users\/[^/]+/, "~");
  const ago = formatTimeAgo(s.lastActivity);
  const lines = [`📁 <b>${escapeHtml(dir)}</b>`, ago];
  if (s.lastMessage) {
    lines.push(`\n<i>${escapeHtml(s.lastMessage)}</i>`);
  }

  await ctx.editMessageText(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "▶️ Resume", callback_data: `sess_resume:${idx}` },
          { text: "✖ Cancel", callback_data: "sess_cancel" },
        ],
      ],
    },
  });
  await ctx.answerCallbackQuery();
  return;
}

// 6. Handle offline session resume: sess_resume:{idx}
if (callbackData.startsWith("sess_resume:")) {
  const idx = parseInt(callbackData.slice(12), 10);
  const sessions = offlineSessionCache.get(chatId);
  const s = sessions?.[idx];

  if (!s) {
    await ctx.answerCallbackQuery({
      text: "Session list expired. Run /sessions again.",
    });
    return;
  }

  const dir = s.dir.replace(/^\/Users\/[^/]+/, "~");
  await ctx.editMessageText(
    `🚀 Spawning desktop session...\n📁 <code>${escapeHtml(dir)}</code>`,
    { parse_mode: "HTML" },
  );
  await ctx.answerCallbackQuery();

  await spawnCmuxSession(ctx.api, chatId, s.dir, userId);
  return;
}

// 7. Handle offline session cancel: sess_cancel
if (callbackData === "sess_cancel") {
  await ctx.editMessageText("✖ Cancelled.");
  await ctx.answerCallbackQuery();
  return;
}
```

`formatTimeAgo` is not currently imported in `callback.ts`. Change the existing formatting import from:

```typescript
import { escapeHtml } from "../formatting";
```

to:

```typescript
import { formatTimeAgo, escapeHtml } from "../formatting";
```

- [ ] **Step 3.2: Run the full test suite**

```bash
bun run test
```

Expected: all tests pass.

- [ ] **Step 3.3: Commit**

```bash
git add src/handlers/callback.ts
git commit -m "feat: add sess_pick/sess_resume/sess_cancel callback handlers"
```

---

## Task 4: Wire up — exports, bot registration

**Files:**

- Modify: `src/handlers/index.ts`
- Modify: `src/bot.ts`

- [ ] **Step 4.1: Export `handleSessions` from `handlers/index.ts`**

In `src/handlers/index.ts`, add `handleSessions` to the existing `commands` export:

```typescript
export {
  handleStart,
  handleHelp,
  handleNew,
  handleStop,
  handleKill,
  handleStatus,
  handleModel,
  handleRestart,
  handleRetry,
  handleList,
  handleSwitch,
  handleRefresh,
  handlePin,
  handleSessions,
  handlePwd,
  handleCd,
  handleLs,
} from "./commands";
```

- [ ] **Step 4.2: Register command in `bot.ts`**

In `src/bot.ts`, add the import and registration. Find the imports block at the top:

```typescript
import {
  handleStart,
  handleHelp,
  handleNew,
  handleStop,
  handleKill,
  handleStatus,
  handleModel,
  handleRestart,
  handleRetry,
  handleList,
  handleSwitch,
  handleRefresh,
  handlePin,
  handleSessions,
  handleWatch,
  handleUnwatch,
  handlePwd,
  handleCd,
  handleLs,
  handleText,
  handleVoice,
  handlePhoto,
  handleDocument,
  handleCallback,
} from "./handlers";
```

Then add the command registration after `/pin`:

```typescript
bot.command("sessions", handleSessions);
```

- [ ] **Step 4.3: Run full test suite**

```bash
bun run test
```

Expected: all tests pass.

- [ ] **Step 4.4: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 4.5: Commit**

```bash
git add src/handlers/index.ts src/bot.ts
git commit -m "feat: register /sessions command in bot"
```

---

## Task 5: Manual smoke test

- [ ] **Step 5.1: Start the bot in dev mode**

```bash
bun run dev
```

- [ ] **Step 5.2: Send `/sessions` in Telegram**

Expected: list of offline sessions with buttons showing directory basenames. If no offline sessions exist, message should say "No offline sessions found."

- [ ] **Step 5.3: Tap a session button**

Expected: message edits to show the directory path, last activity, optional last message snippet, and **▶️ Resume** / **✖ Cancel** buttons.

- [ ] **Step 5.4: Tap Cancel**

Expected: message edits to "✖ Cancelled."

- [ ] **Step 5.5: Tap Resume on a valid session**

Expected:

- Message edits to "🚀 Spawning desktop session... 📁 ~/path"
- Bot sends "⏳ Waiting for Claude to start..."
- cmux opens a new terminal window and starts Claude
- Bot sends watch notifications once Claude comes online
