# Session Identity Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace five fragmented session identity types and six inline relay selector constructions with one canonical `SessionInfo` type and a single `resolveSession()` function that both Telegram and web UI use to reach the correct Claude session.

**Architecture:** Add `startupSource` and `topicId` to `SessionInfo`, delete `SessionOverride` and `TopicMapping`, and introduce `src/sessions/resolver.ts` which wraps relay client acquisition and lazy JSONL path resolution. All routing paths (Telegram text, watch relay, web UI) call `resolveSession(si)` then use `resolved.relay`.

**Tech Stack:** TypeScript/Bun, grammy, Node `net` TCP, Bun test runner. Run tests with `bun run test`; typecheck with `bun run typecheck`.

---

## File Map

| Status | File                                     | Change                                                                                   |
| ------ | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Modify | `src/sessions/types.ts`                  | Rename `source`→`startupSource`, `id` optional, add `topicId?`, delete `SessionOverride` |
| Modify | `src/sessions/watcher.ts`                | Use `startupSource`, optional `id`, add `updateSessionTopicId`                           |
| Modify | `src/sessions/index.ts`                  | Export `updateSessionTopicId`, remove `SessionOverride` re-export                        |
| Modify | `src/types.ts`                           | Delete `TopicMapping`, `TopicStore`                                                      |
| Modify | `src/topics/topic-store.ts`              | Rewrite around `SessionInfo.topicId`                                                     |
| Modify | `src/topics/topic-router.ts`             | Remove `TopicMapping`/`SessionOverride` imports, simplify `isSessionTopic` return        |
| Create | `src/sessions/resolver.ts`               | `resolveSession(si)` + `awaitJsonl()`                                                    |
| Modify | `src/relay/discovery.ts`                 | Unexport `RelaySelector`                                                                 |
| Modify | `src/handlers/text.ts`                   | Use `resolveSession(si)`, drop `SessionOverride` construction                            |
| Modify | `src/handlers/relay-bridge.ts`           | `sendViaRelay` takes `SessionInfo` instead of `SessionOverride`                          |
| Modify | `src/handlers/watch.ts`                  | Fix 3 `getRelayClient` calls, replace `_awaitSessionId` with `awaitJsonl`                |
| Modify | `src/handlers/commands.ts`               | Minor: update any remaining `SessionOverride` refs                                       |
| Modify | `src/web/routes/sessions.ts`             | `sendWebRelay` calls `resolveSession(si).relay`                                          |
| Modify | `src/__tests__/topic-store.test.ts`      | Update for new API                                                                       |
| Modify | `src/__tests__/auto-watch-retry.test.ts` | Replace `_awaitSessionId` tests with `awaitJsonl`                                        |
| Modify | `src/__tests__/commands.test.ts`         | Already updated for `sessionName` — verify still passes                                  |

---

### Task 1: Update `SessionInfo` type and fix all direct callers

**Files:**

- Modify: `src/sessions/types.ts`
- Modify: `src/sessions/watcher.ts`
- Modify: `src/sessions/index.ts`
- Modify: `src/web/routes/sessions.ts` (ApiSession.source field)
- Modify: `src/handlers/watch.ts` (source check)
- Modify: `src/handlers/commands.ts` (source checks)

- [ ] **Step 1: Run typecheck to establish baseline**

```bash
bun run typecheck 2>&1 | tail -5
```

Expected: passes (or shows pre-existing errors only).

- [ ] **Step 2: Rewrite `src/sessions/types.ts`**

```ts
/**
 * Session types for multi-session management.
 */

export interface SessionInfo {
  name: string;
  dir: string;
  /** Claude session UUID — absent until first JSONL write. */
  id?: string;
  lastActivity: number;
  /** Where the session was initiated. */
  startupSource: "telegram" | "desktop";
  /** Claude Code process PID (desktop sessions only). */
  pid?: number;
  /** Telegram message_thread_id — set when topic exists. */
  topicId?: number;
}
```

- [ ] **Step 3: Fix `src/sessions/watcher.ts`**

In `addTelegramSession` (around line 795), change `source: "telegram"` → `startupSource: "telegram"` and remove `id: ""`:

```ts
const info: SessionInfo = {
  name,
  dir,
  lastActivity: Date.now(),
  startupSource: "telegram",
};
```

In `scanSessions` / `parseSessionFile` result construction (wherever `source: "desktop"` is set), rename to `startupSource: "desktop"`.

Search for all occurrences: `grep -n 'source:' src/sessions/watcher.ts`

In `updateSessionId`, the assignment `info.id = sessionId` still works (no change needed).

- [ ] **Step 4: Fix `src/sessions/index.ts`**

Remove `SessionOverride` from the re-export line:

```ts
// Before:
export type { SessionInfo, SessionOverride } from "./types";
// After:
export type { SessionInfo } from "./types";
```

- [ ] **Step 5: Fix `src/web/routes/sessions.ts` — `ApiSession.source` field**

`ApiSession` has `source: "telegram" | "desktop"`. Change its serialization:

```ts
// Before:
source: s.source,
// After:
source: s.startupSource,
```

- [ ] **Step 6: Fix `src/handlers/watch.ts` — `source` check**

Find the check `sessionInfo.source !== "desktop"` and rename:

```ts
// Before:
if (sessionInfo.source !== "desktop") {
// After:
if (sessionInfo.startupSource !== "desktop") {
```

Also find the filter: `allSessions.find((s) => s.source === "desktop")`:

```ts
// After:
allSessions.find((s) => s.startupSource === "desktop");
```

And: `active.info.source === "desktop"` → `active.info.startupSource === "desktop"`

- [ ] **Step 7: Fix `src/handlers/commands.ts` — `source` checks**

Run: `grep -n '\.source' src/handlers/commands.ts`

Rename all `.source ===` / `.source !==` hits to `.startupSource`.

- [ ] **Step 8: Fix `src/topics/topic-router.ts` — remove `SessionOverride` import**

```ts
// Remove this import entirely:
import type { SessionOverride } from "../sessions/types";
```

Also remove `SessionOverride` from the `loadTopicSession` return type and its construction. The function currently returns `sessionOverride` — make it return `SessionInfo | null` instead, or just remove the function (its callers will be updated in later tasks).

Actually for now: comment out `loadTopicSession` body temporarily, or simplify it to just return `{threadId}` without `sessionOverride`:

```ts
export function loadTopicSession(
  ctx: Context,
): { threadId: number } | undefined {
  const topicCtx = isSessionTopic(ctx);
  if (!topicCtx) return undefined;
  const si = getSession(topicCtx.sessionName);
  if (si) session.loadFromRegistry(si);
  return { threadId: topicCtx.topicId };
}
```

Also update `isSessionTopic` return type to not reference `TopicMapping` (you'll need this after Task 2 deletes it — pre-emptively remove the field):

```ts
export function isSessionTopic(
  ctx: Context,
): { sessionName: string; topicId: number } | null {
  const threadId = ctx.message?.message_thread_id;
  if (!threadId || threadId === 1) return null;
  const mapping = getSessionByTopic(threadId);
  if (!mapping) return null;
  return { sessionName: mapping.sessionName, topicId: mapping.topicId };
}
```

Remove the `import type { TopicMapping } from "../types";` from `topic-router.ts`.

- [ ] **Step 9: Fix remaining compilation errors**

```bash
bun run typecheck 2>&1
```

Fix any remaining errors. Common ones: `si.id` used where `string | undefined` now causes issues — replace `si.id` checks with `si.id ?? ""` or guard `if (si.id)`.

For `id: ""` → now `id: undefined`. If code does `session.id === ""`, change to `!session.id`.

- [ ] **Step 10: Run tests**

```bash
bun run test 2>&1 | tail -20
```

Expected: all pass (or only pre-existing failures unrelated to this change).

- [ ] **Step 11: Commit**

```bash
git add src/sessions/types.ts src/sessions/watcher.ts src/sessions/index.ts \
        src/web/routes/sessions.ts src/handlers/watch.ts src/handlers/commands.ts \
        src/topics/topic-router.ts
git commit -m "refactor: rename source→startupSource, make id optional, add topicId to SessionInfo"
```

---

### Task 2: Delete `TopicMapping` and rewrite `topic-store.ts`

**Files:**

- Modify: `src/types.ts` — delete `TopicMapping`, `TopicStore`
- Modify: `src/sessions/watcher.ts` — add `updateSessionTopicId`
- Modify: `src/sessions/index.ts` — export `updateSessionTopicId`
- Modify: `src/topics/topic-store.ts` — rewrite
- Modify: `src/__tests__/topic-store.test.ts` — update tests

The new topic-store keeps a standalone `Map<number, string>` (topicId → sessionName) for fast lookup. It persists `{topicId, sessionName}[]`. Live sessions get `topicId` set on their `SessionInfo` via `updateSessionTopicId`. Offline lookups fall back to the map.

- [ ] **Step 1: Add `updateSessionTopicId` to `src/sessions/watcher.ts`**

After `updateSessionActivity` (around line 830):

```ts
/**
 * Set the Telegram topic ID for a session.
 */
export function updateSessionTopicId(name: string, topicId: number): void {
  const info = cache.sessions.get(name);
  if (info) {
    info.topicId = topicId;
  }
}
```

- [ ] **Step 2: Export from `src/sessions/index.ts`**

Add to the watcher exports block:

```ts
export {
  startWatcher,
  stopWatcher,
  forceRefresh,
  getSessions,
  getActiveSession,
  setActiveSession,
  getSession,
  addTelegramSession,
  updateSessionId,
  updateSessionActivity,
  updateSessionTopicId, // ADD THIS
  removeSession,
} from "./watcher";
```

- [ ] **Step 3: Delete `TopicMapping` and `TopicStore` from `src/types.ts`**

Remove these lines (around line 114–128):

```ts
// DELETE:
export interface TopicMapping { ... }
export interface TopicStore { ... }
```

- [ ] **Step 4: Write failing tests for new topic-store API**

Open `src/__tests__/topic-store.test.ts` and replace its contents with tests that exercise the new API:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "1";

let topicStore: typeof import("../topics/topic-store");

describe("topic-store", () => {
  beforeEach(async () => {
    process.env.CLAUDE_TELEGRAM_TOPICS_FILE = `/tmp/test-topics-${Date.now()}.json`;
    topicStore = await import("../topics/topic-store");
    topicStore.clearTopicStore();
    topicStore.setChatId(12345);
  });

  afterEach(() => {
    topicStore.clearTopicStore();
    delete process.env.CLAUDE_TELEGRAM_TOPICS_FILE;
  });

  test("addTopicMapping and getSessionByTopic round-trip", () => {
    topicStore.addTopicMapping({ topicId: 100, sessionName: "proj-1" });
    const result = topicStore.getSessionByTopic(100);
    expect(result).toEqual({ topicId: 100, sessionName: "proj-1" });
  });

  test("getTopicBySession returns mapping by name", () => {
    topicStore.addTopicMapping({ topicId: 200, sessionName: "proj-2" });
    const result = topicStore.getTopicBySession("proj-2");
    expect(result?.topicId).toBe(200);
  });

  test("removeTopicMapping removes entry", () => {
    topicStore.addTopicMapping({ topicId: 300, sessionName: "proj-3" });
    topicStore.removeTopicMapping("proj-3");
    expect(topicStore.getSessionByTopic(300)).toBeUndefined();
  });

  test("updateTopicMapping updates existing entry", () => {
    topicStore.addTopicMapping({ topicId: 400, sessionName: "proj-4" });
    topicStore.updateTopicMapping("proj-4", { topicId: 401 });
    expect(topicStore.getSessionByTopic(401)?.sessionName).toBe("proj-4");
    expect(topicStore.getSessionByTopic(400)).toBeUndefined();
  });

  test("clearTopicStore empties state", () => {
    topicStore.addTopicMapping({ topicId: 500, sessionName: "proj-5" });
    topicStore.clearTopicStore();
    expect(topicStore.getSessionByTopic(500)).toBeUndefined();
  });
});
```

Run to confirm failure:

```bash
bun run test src/__tests__/topic-store.test.ts 2>&1 | tail -20
```

- [ ] **Step 5: Rewrite `src/topics/topic-store.ts`**

```ts
/**
 * Persistence layer for topic ↔ session mappings.
 * topicId lives on SessionInfo; this store is the persistence/lookup layer.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { getSessions, updateSessionTopicId } from "../sessions";
import { debug, info, warn } from "../logger";

interface TopicEntry {
  topicId: number;
  sessionName: string;
}

interface PersistedStore {
  chatId: number;
  topics: TopicEntry[];
}

function storePath(): string {
  return (
    process.env.CLAUDE_TELEGRAM_TOPICS_FILE ??
    join(homedir(), ".claude-mobile-bridge", "topics.json")
  );
}

let chatId = 0;
// topicId → sessionName (for fast lookup)
const topicMap = new Map<number, string>();
// sessionName → topicId
const sessionMap = new Map<string, number>();

let dirEnsured = false;
async function ensureStoreDir(path: string): Promise<void> {
  if (dirEnsured) return;
  await mkdir(dirname(path), { recursive: true });
  dirEnsured = true;
}

export function getTopicStore(): { chatId: number; topics: TopicEntry[] } {
  return {
    chatId,
    topics: [...topicMap.entries()].map(([topicId, sessionName]) => ({
      topicId,
      sessionName,
    })),
  };
}

export function setChatId(id: number): void {
  if (chatId === id) return;
  chatId = id;
  scheduleSave();
}

export async function loadTopicStore(): Promise<void> {
  const path = storePath();
  try {
    const data = await readFile(path, "utf-8");
    const parsed = JSON.parse(data) as PersistedStore;
    if (parsed && Array.isArray(parsed.topics)) {
      chatId = parsed.chatId ?? 0;
      for (const { topicId, sessionName } of parsed.topics) {
        topicMap.set(topicId, sessionName);
        sessionMap.set(sessionName, topicId);
      }
      // Apply topicIds to any already-loaded live sessions
      for (const si of getSessions()) {
        const tid = sessionMap.get(si.name);
        if (tid !== undefined) updateSessionTopicId(si.name, tid);
      }
      debug(`topic-store: loaded ${topicMap.size} mapping(s)`);
    }
  } catch {
    // Fresh start — no persisted state
  }
}

export async function saveTopicStore(): Promise<void> {
  if (chatId === 0) {
    debug(`topic-store: skip save (chatId=0)`);
    return;
  }
  const path = storePath();
  try {
    await ensureStoreDir(path);
    const store: PersistedStore = { chatId, topics: getTopicStore().topics };
    await writeFile(path, JSON.stringify(store, null, 2));
    debug(`topic-store: saved ${topicMap.size} mapping(s)`);
  } catch (err) {
    warn(`topic-store: save failed: ${err}`);
  }
}

let saveTimer: Timer | null = null;
function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveTopicStore();
  }, 100);
}

export function addTopicMapping(entry: TopicEntry): void {
  topicMap.set(entry.topicId, entry.sessionName);
  sessionMap.set(entry.sessionName, entry.topicId);
  updateSessionTopicId(entry.sessionName, entry.topicId);
  scheduleSave();
}

export function removeTopicMapping(sessionName: string): void {
  const topicId = sessionMap.get(sessionName);
  if (topicId !== undefined) topicMap.delete(topicId);
  sessionMap.delete(sessionName);
  scheduleSave();
}

export function getTopicBySession(sessionName: string): TopicEntry | undefined {
  const topicId = sessionMap.get(sessionName);
  if (topicId === undefined) return undefined;
  return { topicId, sessionName };
}

export function getSessionByTopic(topicId: number): TopicEntry | undefined {
  const sessionName = topicMap.get(topicId);
  if (!sessionName) return undefined;
  return { topicId, sessionName };
}

export function updateTopicMapping(
  sessionName: string,
  update: Partial<TopicEntry>,
): void {
  const existing = sessionMap.get(sessionName);
  if (existing === undefined) return;

  if (update.topicId !== undefined && update.topicId !== existing) {
    // Topic ID changed — re-index
    topicMap.delete(existing);
    topicMap.set(update.topicId, sessionName);
    sessionMap.set(sessionName, update.topicId);
    updateSessionTopicId(sessionName, update.topicId);
  }
  scheduleSave();
}

export function clearTopicStore(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  dirEnsured = false;
  chatId = 0;
  topicMap.clear();
  sessionMap.clear();
}
```

- [ ] **Step 6: Fix topic-manager.ts — remove TopicMapping-specific fields**

In `src/topics/topic-manager.ts`, callers of `addTopicMapping` pass full `TopicMapping` objects. Update all call sites:

```ts
// Before:
addTopicMapping({
  topicId,
  sessionName,
  sessionDir,
  sessionId,
  isOnline: true,
  createdAt: new Date().toISOString(),
});
// After:
addTopicMapping({ topicId, sessionName });
```

Also `updateTopicMapping(sessionName, { isOnline: true, sessionId })` — these fields no longer exist. Remove `isOnline` and `sessionId` from update calls (they are now derivable from the sessions cache).

- [ ] **Step 7: Fix compilation errors and run tests**

```bash
bun run typecheck 2>&1
bun run test src/__tests__/topic-store.test.ts 2>&1 | tail -20
bun run test 2>&1 | tail -20
```

Fix any remaining errors. The `topic-router.test.ts` and `topic-manager.test.ts` may need updates since return types changed.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/sessions/watcher.ts src/sessions/index.ts \
        src/topics/topic-store.ts src/topics/topic-manager.ts \
        src/__tests__/topic-store.test.ts
git commit -m "refactor: delete TopicMapping, rewrite topic-store around SessionInfo.topicId"
```

---

### Task 3: Create `src/sessions/resolver.ts`

**Files:**

- Create: `src/sessions/resolver.ts`
- Create: `src/__tests__/resolver.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/resolver.test.ts`:

```ts
import { describe, test, expect, mock, beforeEach } from "bun:test";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "1";

// We'll test resolveSession via mocking at the module boundary.
// Key behaviors:
// 1. relay is null when no relay client found
// 2. relay is non-null when getRelayClient succeeds
// 3. awaitJsonl() resolves when session.id becomes available
// 4. awaitJsonl() throws when session disappears

describe("resolveSession", () => {
  test("returns relay: null when session is offline", async () => {
    // Mock getRelayClient to return null
    mock.module("../relay/discovery", () => ({
      getRelayClient: async () => null,
    }));
    mock.module("../sessions/watcher", () => ({
      getSession: () => ({
        name: "proj",
        dir: "/p",
        startupSource: "desktop" as const,
        lastActivity: 0,
      }),
      forceRefresh: async () => {},
    }));

    const { resolveSession } = await import("../sessions/resolver");
    const si = {
      name: "proj",
      dir: "/p",
      startupSource: "desktop" as const,
      lastActivity: 0,
    };
    const resolved = await resolveSession(si);
    expect(resolved.relay).toBeNull();
    expect(resolved.session).toBe(si);
  });

  test("awaitJsonl throws when session id never appears", async () => {
    mock.module("../relay/discovery", () => ({
      getRelayClient: async () => null,
    }));
    mock.module("../sessions/watcher", () => ({
      getSession: () => ({
        name: "proj",
        dir: "/p",
        startupSource: "desktop" as const,
        lastActivity: 0,
      }), // no id
      forceRefresh: async () => {},
    }));
    mock.module("../sessions/tailer", () => ({
      findSessionJsonlPath: async () => null,
      getExpectedJsonlPath: () => "/fake/path.jsonl",
    }));

    const { resolveSession } = await import("../sessions/resolver");
    const si = {
      name: "proj",
      dir: "/p",
      startupSource: "desktop" as const,
      lastActivity: 0,
    };
    const resolved = await resolveSession(si);
    await expect(resolved.awaitJsonl([], 0)).rejects.toThrow();
  });
});
```

Run to confirm failure:

```bash
bun run test src/__tests__/resolver.test.ts 2>&1 | tail -10
```

Expected: FAIL (file does not exist).

- [ ] **Step 2: Create `src/sessions/resolver.ts`**

```ts
/**
 * Session resolver — canonical entry point for acquiring a relay client
 * and JSONL path for any SessionInfo.
 */

import { getRelayClient } from "../relay/discovery";
import type { RelayClient } from "../relay/client";
import { findSessionJsonlPath, getExpectedJsonlPath } from "./tailer";
import { forceRefresh, getSession } from "./watcher";
import { warn } from "../logger";
import type { SessionInfo } from "./types";

export interface ResolvedSession {
  session: SessionInfo;
  relay: RelayClient | null;
  /** Waits for session UUID + JSONL file, then returns path. Throws after ~37s. */
  awaitJsonl(delaysMs?: number[], initialDelayMs?: number): Promise<string>;
}

const DEFAULT_RETRY_DELAYS_MS = [2000, 5000, 10000, 20000];

/**
 * Resolve a session to its relay client (fast, non-blocking) and
 * a lazy awaitJsonl() function (only needed before starting a tailer).
 */
export async function resolveSession(
  si: SessionInfo,
): Promise<ResolvedSession> {
  const relay = await getRelayClient({
    sessionName: si.name,
    sessionDir: si.dir,
    claudePid: si.pid,
    sessionId: si.id,
  });

  return {
    session: si,
    relay,
    awaitJsonl: (delaysMs = DEFAULT_RETRY_DELAYS_MS, initialDelayMs = 0) =>
      _awaitJsonl(si, delaysMs, initialDelayMs),
  };
}

async function _awaitJsonl(
  si: SessionInfo,
  delaysMs: number[],
  initialDelayMs: number,
): Promise<string> {
  const delays =
    initialDelayMs > 0 ? [initialDelayMs, ...delaysMs] : [0, ...delaysMs];

  for (const delay of delays) {
    if (delay) await Bun.sleep(delay);
    await forceRefresh();
    const current = getSession(si.name);
    if (!current) {
      throw new Error(`session ${si.name} disappeared while awaiting JSONL`);
    }
    if (current.id) {
      const path =
        (await findSessionJsonlPath(current.id)) ??
        getExpectedJsonlPath(current.dir, current.id);
      return path;
    }
  }

  throw new Error(
    `session ${si.name}: JSONL path unavailable after retries (~37s)`,
  );
}
```

- [ ] **Step 3: Run tests**

```bash
bun run test src/__tests__/resolver.test.ts 2>&1 | tail -20
bun run typecheck 2>&1 | tail -5
```

Expected: tests pass, typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add src/sessions/resolver.ts src/__tests__/resolver.test.ts
git commit -m "feat: add resolveSession — canonical relay + JSONL resolver"
```

---

### Task 4: Unexport `RelaySelector` from `discovery.ts`

**Files:**

- Modify: `src/relay/discovery.ts`

`RelaySelector` is used only inside `discovery.ts` internally. Making it unexported enforces the "internal implementation detail" invariant.

- [ ] **Step 1: Check callers of `RelaySelector`**

```bash
grep -rn "RelaySelector" src/ --include="*.ts"
```

Expected: only `src/relay/discovery.ts` references it. If external callers exist, update them to pass the fields directly to `getRelayClient` before this step.

- [ ] **Step 2: Remove `export` from `RelaySelector`**

In `src/relay/discovery.ts` around line 25:

```ts
// Before:
export interface RelaySelector {
// After:
interface RelaySelector {
```

- [ ] **Step 3: Typecheck and commit**

```bash
bun run typecheck 2>&1
```

Expected: clean (or only pre-existing errors).

```bash
git add src/relay/discovery.ts
git commit -m "refactor: make RelaySelector unexported (internal to discovery.ts)"
```

---

### Task 5: Update `src/handlers/text.ts` — use `resolveSession`

**Files:**

- Modify: `src/handlers/text.ts`

The goal: remove the inline `sessionOverride` construction and replace it with `resolveSession(si)`.

- [ ] **Step 1: Add import for resolveSession**

At the top of `src/handlers/text.ts`, add:

```ts
import { resolveSession } from "../sessions/resolver";
```

Remove:

```ts
import type { SessionOverride } from "../sessions/types";
```

- [ ] **Step 2: Replace the sessionOverride construction block**

Around line 79–96 of `text.ts`, the current code:

```ts
let threadId: number | undefined;
let sessionOverride: SessionOverride | undefined;

if (isTopicChat(ctx)) {
  const topicCtx = isSessionTopic(ctx);
  if (topicCtx) {
    threadId = topicCtx.topicId;
    const si = getSession(topicCtx.sessionName);
    if (si) {
      session.loadFromRegistry(si);
      sessionOverride = {
        sessionId: si.id || "",
        sessionDir: si.dir,
        sessionPid: si.pid,
        sessionName: si.name,
      };
    }
  } else if (isGeneralTopic(ctx)) { ... }
}
```

Replace with:

```ts
let threadId: number | undefined;
let topicSession: import("../sessions/types").SessionInfo | undefined;

if (isTopicChat(ctx)) {
  const topicCtx = isSessionTopic(ctx);
  if (topicCtx) {
    threadId = topicCtx.topicId;
    const si = getSession(topicCtx.sessionName);
    if (si) {
      session.loadFromRegistry(si);
      topicSession = si;
    }
  } else if (isGeneralTopic(ctx)) {
    if (
      !pendingSettingsInput.has(chatId) &&
      !pendingPlanFeedback.has(chatId) &&
      !pendingAskUserQuestionCustom.has(chatId)
    ) {
      await ctx.reply(
        "❌ Send messages in a session topic.\nUse /list to see sessions.",
      );
      return;
    }
  }
}
```

- [ ] **Step 3: Update the relay path in text.ts (step 7.5)**

Around line 441, replace `sendViaRelay` call's `sessionOverride` arg:

```ts
// Before:
const relayResult = await sendViaRelay(
  ctx,
  message,
  username,
  chatId,
  undefined,
  opId,
  threadId,
  sessionOverride,
);

// After:
const relayResult = await sendViaRelay(
  ctx,
  message,
  username,
  chatId,
  undefined,
  opId,
  threadId,
  topicSession,
);
```

And update the watch relay call (around line 339):

```ts
// Before:
const relayed = await sendWatchRelay(
  chatId,
  threadId,
  username,
  message,
  opId,
  undefined,
  sessionOverride,
);
// After:
const relayed = await sendWatchRelay(
  chatId,
  threadId,
  username,
  message,
  opId,
  undefined,
  topicSession,
);
```

- [ ] **Step 4: Typecheck and run tests**

```bash
bun run typecheck 2>&1
bun run test 2>&1 | tail -10
```

Fix any type errors — `sendViaRelay` and `sendWatchRelay` signatures will be updated in Tasks 6 and 7 to accept `SessionInfo | undefined`. For now, temporarily cast if needed.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/text.ts
git commit -m "refactor: text.ts — drop SessionOverride, pass SessionInfo to relay calls"
```

---

### Task 6: Update `src/handlers/relay-bridge.ts` — take `SessionInfo`

**Files:**

- Modify: `src/handlers/relay-bridge.ts`

Replace `sessionOverride?: SessionOverride` with `topicSession?: SessionInfo` throughout.

- [ ] **Step 1: Update imports**

```ts
// Remove:
import type { SessionOverride } from "../sessions/types";
// Add:
import type { SessionInfo } from "../sessions/types";
```

- [ ] **Step 2: Update `sendViaRelay` signature**

```ts
// Before:
export async function sendViaRelay(
  ctx: Context,
  message: string,
  username: string,
  chatId: number,
  imagePath?: string,
  opId?: string,
  threadId?: number,
  sessionOverride?: SessionOverride,
): Promise<RelayResult>;

// After:
export async function sendViaRelay(
  ctx: Context,
  message: string,
  username: string,
  chatId: number,
  imagePath?: string,
  opId?: string,
  threadId?: number,
  topicSession?: SessionInfo,
): Promise<RelayResult>;
```

- [ ] **Step 3: Update the body of `sendViaRelay`**

Replace the `sessionOverride` usages inside `sendViaRelay`:

```ts
// Before (around line 52-63):
const active = getActiveSession();
const sessionId =
  sessionOverride?.sessionId || active?.info.id || session.sessionId;
const sessionDir =
  sessionOverride?.sessionDir || session.workingDir || active?.info.dir;
if (!sessionDir) return "unavailable";
const client = await getRelayClient({
  sessionId: sessionId || undefined,
  sessionDir,
  claudePid: sessionOverride?.sessionPid ?? active?.info.pid,
  sessionName: sessionOverride?.sessionName,
});

// After:
const active = getActiveSession();
const si = topicSession ?? active?.info;
const sessionId = si?.id || session.sessionId;
const sessionDir = si?.dir || session.workingDir;
if (!sessionDir) return "unavailable";
const client = await getRelayClient({
  sessionId: sessionId || undefined,
  sessionDir,
  claudePid: si?.pid,
  sessionName: si?.name,
});
```

Also update the `sendWatchRelay` call (around line 37-47) to pass `topicSession`:

```ts
// Before:
if (threadId !== undefined && isWatching(chatId, threadId)) {
  const relayed = await sendWatchRelay(
    chatId, threadId, username, message, opId, imagePath, sessionOverride,
  );

// After:
if (threadId !== undefined && isWatching(chatId, threadId)) {
  const relayed = await sendWatchRelay(
    chatId, threadId, username, message, opId, imagePath, topicSession,
  );
```

- [ ] **Step 4: Typecheck and test**

```bash
bun run typecheck 2>&1
bun run test 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/relay-bridge.ts
git commit -m "refactor: relay-bridge.ts — take SessionInfo instead of SessionOverride"
```

---

### Task 7: Update `src/handlers/watch.ts` — fix relay calls and replace `_awaitSessionId`

**Files:**

- Modify: `src/handlers/watch.ts`
- Modify: `src/__tests__/auto-watch-retry.test.ts`

Three `getRelayClient` calls are missing `sessionName`. `_awaitSessionId` is deleted and replaced by `resolveSession(...).awaitJsonl()`.

- [ ] **Step 1: Add import for `resolveSession`**

```ts
import { resolveSession } from "../sessions/resolver";
```

Remove:

```ts
import type { SessionOverride } from "../sessions/types";
```

- [ ] **Step 2: Update `sendWatchRelay` signature — accept `SessionInfo` instead of `SessionOverride`**

```ts
// Before:
export async function sendWatchRelay(
  chatId: number,
  threadId: number,
  username: string,
  text: string,
  opId?: string,
  imagePath?: string,
  sessionOverride?: SessionOverride,
): Promise<boolean>;

// After:
export async function sendWatchRelay(
  chatId: number,
  threadId: number,
  username: string,
  text: string,
  opId?: string,
  imagePath?: string,
  topicSession?: import("../sessions/types").SessionInfo,
): Promise<boolean>;
```

Inside `sendWatchRelay` (around line 410-415), fix the relay selector:

```ts
// Before:
const target = sessionOverride || state;
const client = await getRelayClient({
  sessionId: target.sessionId,
  sessionDir: target.sessionDir,
  claudePid: target.sessionPid,
});

// After:
const client = await getRelayClient({
  sessionName: topicSession?.name ?? state.sessionName,
  sessionId: topicSession?.id ?? state.sessionId,
  sessionDir: topicSession?.dir ?? state.sessionDir,
  claudePid: topicSession?.pid ?? state.sessionPid,
});
```

- [ ] **Step 3: Fix `startAutoWatch` — replace `_awaitSessionId` with `awaitJsonl`**

In `startAutoWatch` (around line 684-706):

```ts
// Before:
const sessionInfo = await _awaitSessionId(sessionName);
if (!sessionInfo?.id) {
  warn("auto-watch: start failed, missing session id after retries", { ... });
  return false;
}
// ...
const jsonlPath =
  (await findSessionJsonlPath(sessionInfo.id)) ??
  getExpectedJsonlPath(sessionInfo.dir, sessionInfo.id);

// After:
const si = getSession(sessionName);
if (!si) {
  warn("auto-watch: session not found", { chatId, threadId, sessionName });
  return false;
}
const resolved = await resolveSession(si);
let jsonlPath: string;
try {
  jsonlPath = await resolved.awaitJsonl();
} catch {
  warn("auto-watch: start failed, JSONL unavailable after retries", {
    chatId, threadId, sessionName,
  });
  return false;
}
const sessionInfo = getSession(sessionName) ?? si;
```

Then update the relay wiring call (around line 751-754) to add `sessionName`:

```ts
// Before:
const relayClient = await getRelayClient({
  sessionId: sessionInfo.id,
  sessionDir: sessionInfo.dir,
  claudePid: sessionInfo.pid,
});

// After:
const relayClient = await getRelayClient({
  sessionName: sessionInfo.name,
  sessionId: sessionInfo.id,
  sessionDir: sessionInfo.dir,
  claudePid: sessionInfo.pid,
});
```

- [ ] **Step 4: Fix `startWatchingSession` — add `sessionName` to both `getRelayClient` calls**

Around line 977-980:

```ts
// Before:
const relayClient = await getRelayClient({
  sessionId: sessionInfo.id,
  sessionDir: sessionInfo.dir,
  claudePid: sessionInfo.pid,
});

// After:
const relayClient = await getRelayClient({
  sessionName: targetName,
  sessionId: sessionInfo.id,
  sessionDir: sessionInfo.dir,
  claudePid: sessionInfo.pid,
});
```

- [ ] **Step 5: Delete `_awaitSessionId` function**

Remove the entire `_awaitSessionId` function (around line 639-651) from `watch.ts`:

```ts
// DELETE THIS FUNCTION:
export async function _awaitSessionId(
  sessionName: string,
  delaysMs: number[] = AUTO_WATCH_RETRY_DELAYS_MS,
): Promise<import("../sessions/types").SessionInfo | null> { ... }
```

Also remove the `AUTO_WATCH_RETRY_DELAYS_MS` constant (line 629) since it's only used by `_awaitSessionId`.

- [ ] **Step 6: Update `src/__tests__/auto-watch-retry.test.ts`**

Open the test file and check what it tests. Since `_awaitSessionId` is deleted, these tests need to be replaced with tests for `resolveSession().awaitJsonl()` behavior:

```ts
// src/__tests__/auto-watch-retry.test.ts
import { describe, test, expect, mock } from "bun:test";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "1";

describe("resolver awaitJsonl retry behavior", () => {
  test("awaitJsonl resolves immediately when session id available", async () => {
    mock.module("../sessions/watcher", () => ({
      getSession: () => ({
        name: "proj",
        dir: "/proj",
        id: "uuid-1234",
        startupSource: "desktop" as const,
        lastActivity: 0,
      }),
      forceRefresh: async () => {},
    }));
    mock.module("../sessions/tailer", () => ({
      findSessionJsonlPath: async () => "/proj/.claude/uuid-1234.jsonl",
      getExpectedJsonlPath: () => "/proj/.claude/uuid-1234.jsonl",
    }));
    mock.module("../relay/discovery", () => ({
      getRelayClient: async () => null,
    }));

    const { resolveSession } = await import("../sessions/resolver");
    const si = {
      name: "proj",
      dir: "/proj",
      startupSource: "desktop" as const,
      lastActivity: 0,
    };
    const resolved = await resolveSession(si);
    const path = await resolved.awaitJsonl([], 0);
    expect(path).toContain("uuid-1234");
  });

  test("awaitJsonl throws after retries when id never appears", async () => {
    mock.module("../sessions/watcher", () => ({
      getSession: () => ({
        name: "proj",
        dir: "/proj",
        startupSource: "desktop" as const,
        lastActivity: 0,
        // no id
      }),
      forceRefresh: async () => {},
    }));
    mock.module("../sessions/tailer", () => ({
      findSessionJsonlPath: async () => null,
      getExpectedJsonlPath: () => "/proj/.claude/pending.jsonl",
    }));
    mock.module("../relay/discovery", () => ({
      getRelayClient: async () => null,
    }));

    const { resolveSession } = await import("../sessions/resolver");
    const si = {
      name: "proj",
      dir: "/proj",
      startupSource: "desktop" as const,
      lastActivity: 0,
    };
    const resolved = await resolveSession(si);
    // Pass empty delays so it fails immediately (no real sleeping in tests)
    await expect(resolved.awaitJsonl([], 0)).rejects.toThrow(
      "JSONL path unavailable",
    );
  });

  test("awaitJsonl throws when session disappears", async () => {
    mock.module("../sessions/watcher", () => ({
      getSession: () => null, // session gone
      forceRefresh: async () => {},
    }));
    mock.module("../relay/discovery", () => ({
      getRelayClient: async () => null,
    }));

    const { resolveSession } = await import("../sessions/resolver");
    const si = {
      name: "proj",
      dir: "/proj",
      startupSource: "desktop" as const,
      lastActivity: 0,
    };
    const resolved = await resolveSession(si);
    await expect(resolved.awaitJsonl([], 0)).rejects.toThrow("disappeared");
  });
});
```

- [ ] **Step 7: Typecheck and run tests**

```bash
bun run typecheck 2>&1
bun run test src/__tests__/auto-watch-retry.test.ts 2>&1 | tail -20
bun run test src/__tests__/watch.test.ts 2>&1 | tail -20
bun run test 2>&1 | tail -10
```

Fix any remaining errors.

- [ ] **Step 8: Commit**

```bash
git add src/handlers/watch.ts src/__tests__/auto-watch-retry.test.ts
git commit -m "refactor: watch.ts — fix sessionName routing, replace _awaitSessionId with resolver.awaitJsonl"
```

---

### Task 8: Update `src/handlers/commands.ts` and `src/web/routes/sessions.ts`

**Files:**

- Modify: `src/handlers/commands.ts` — verify no residual `SessionOverride` usage
- Modify: `src/web/routes/sessions.ts` — use `resolveSession`

- [ ] **Step 1: Check commands.ts for any remaining SessionOverride references**

```bash
grep -n "SessionOverride\|sessionOverride" src/handlers/commands.ts
```

The `disconnectRelay` call already uses `SessionInfo` fields directly. If any `SessionOverride` refs remain, update them to use `SessionInfo` directly.

The `killSession` function (search: `grep -n "killSession\|disconnectRelay" src/handlers/commands.ts`) already calls:

```ts
disconnectRelay({
  sessionName: sessionInfo.name,
  sessionDir: sessionInfo.dir,
  sessionId: sessionInfo.id,
  claudePid: sessionInfo.pid,
});
```

This is already correct. Verify with `bun run typecheck`.

- [ ] **Step 2: Update `src/web/routes/sessions.ts` — use `resolveSession`**

Add import:

```ts
import { resolveSession } from "../../sessions/resolver";
```

Update `sendWebRelay`:

```ts
async function sendWebRelay(
  si: SessionInfo,
  text: string,
  emit: (type: SseEvent["type"], content: string) => void,
): Promise<void> {
  const { relay: client } = await resolveSession(si);
  if (!client) {
    emit("text", "⚠ Relay unavailable for this session.");
    emit("done", "");
    return;
  }
  // rest of function unchanged
```

- [ ] **Step 3: Run typecheck and full test suite**

```bash
bun run typecheck 2>&1
bun run test 2>&1 | tail -20
```

All tests should pass.

- [ ] **Step 4: Commit**

```bash
git add src/handlers/commands.ts src/web/routes/sessions.ts
git commit -m "refactor: commands.ts + web sessions — remove SessionOverride, use resolveSession"
```

---

### Task 9: Final validation and cleanup

**Files:**

- Check all files for residual references

- [ ] **Step 1: Search for orphaned references**

```bash
grep -rn "SessionOverride" src/ --include="*.ts"
grep -rn "TopicMapping" src/ --include="*.ts"
grep -rn "_awaitSessionId" src/ --include="*.ts"
grep -rn "\.source\b" src/ --include="*.ts" | grep -v "startupSource\|source:" | grep -v "//\|\.ts:" | head -20
```

Expected: zero hits for `SessionOverride`, `TopicMapping`, `_awaitSessionId`.

Any `.source` hits should be for other unrelated uses (e.g. event sources), not `SessionInfo.source`.

- [ ] **Step 2: Run the full test suite**

```bash
bun run test 2>&1
```

Expected: all pass. If `web-tasks-watcher.test.ts` flakes (known flaky test with timing issues), re-run once.

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck 2>&1
```

Expected: clean output (no errors).

- [ ] **Step 4: Smoke test the full path manually**

Start the bot in dev mode and verify:

1. Sending a message in a Telegram session topic routes correctly (`relay: connected` in logs)
2. `/watch` starts and shows live events
3. Desktop label (`🖥 Desktop:`) appears when typing in terminal
4. Web UI can send messages to the correct session

- [ ] **Step 5: Final commit if any cleanup was needed**

```bash
git add -p  # review remaining changes
git commit -m "refactor: final cleanup — remove residual SessionOverride and TopicMapping refs"
```

---

## Self-Review

**Spec coverage:**

- ✅ `SessionInfo.startupSource` — Task 1
- ✅ `SessionInfo.topicId?` — Task 1 + Task 2
- ✅ `SessionInfo.id?` optional — Task 1
- ✅ `SessionOverride` deleted — Task 1 (type) + Tasks 5-8 (callers)
- ✅ `TopicMapping` deleted — Task 2
- ✅ `RelaySelector` unexported — Task 4
- ✅ `resolveSession(si)` created — Task 3
- ✅ `awaitJsonl()` lazy — Task 3, used in Task 7
- ✅ `text.ts` uses `resolveSession` — Task 5
- ✅ `relay-bridge.ts` takes `SessionInfo` — Task 6
- ✅ `watch.ts` fixes 3 `getRelayClient` calls — Task 7
- ✅ `_awaitSessionId` deleted — Task 7
- ✅ `commands.ts` uses `SessionInfo` directly — Task 8
- ✅ `sessions.ts` (web) uses `resolveSession` — Task 8

**Type consistency check:**

- `resolveSession(si: SessionInfo)` → `ResolvedSession` — consistent across Tasks 3, 5, 6, 7, 8
- `awaitJsonl(delaysMs?, initialDelayMs?)` — signature used correctly in Task 7 (pass `[]` and `0` in tests to skip sleeping)
- `startupSource` (not `source`) — used consistently after Task 1
- `topicId?: number` on `SessionInfo` — set via `updateSessionTopicId` in task 2, read by topic-store lookups

**Placeholder scan:** No TBD or TODO in steps. All code blocks are complete.
