# Multi-Topic Concurrent Watches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support one active `watch` per Telegram topic, concurrent across all topics in a chat, so killing or spawning a session in one topic no longer kills other topics' watches.

**Architecture:** Change the `watches` / `typingState` maps in `src/handlers/watch.ts` from `Map<chatId, WatchState>` to `Map<"chatId:threadId", WatchState>`. Make `threadId` required at `WatchState` construction. Add `stopWatchByDir` so `killSession` stops only the watch for the killed session's dir. Drop the `setWatchThreadId` retrofit — threadId is known at spawn time.

**Tech Stack:** Bun, TypeScript, grammy (Telegram bot framework), existing test harness (`bun test` via `bun run test`).

**Spec:** `docs/superpowers/specs/2026-04-16-multi-topic-watches-design.md`

**Strategy note:** This is a coordinated refactor where the map keying, helper signatures, and all call sites must change together to keep the build green. Tasks are structured so every commit compiles and all tests pass.

---

## Task 1: Add test seams `_resetWatchesForTests` and `_registerWatchForTests`

**Files:**

- Modify: `src/handlers/watch.ts`
- Modify: `src/__tests__/watch.test.ts`

- [ ] **Step 1: Write a failing test**

Append to `src/__tests__/watch.test.ts`, inside the existing `describe("watch: state management (via exports)", () => { … })` block:

```ts
test("_resetWatchesForTests clears state", async () => {
  const mod = await import("../handlers/watch");
  expect(typeof mod._resetWatchesForTests).toBe("function");
  expect(typeof mod._registerWatchForTests).toBe("function");
  mod._resetWatchesForTests();
  expect(mod.isWatching(123456)).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun run test src/__tests__/watch.test.ts
```

Expected: FAIL with `_resetWatchesForTests is not a function`.

- [ ] **Step 3: Add the exports**

In `src/handlers/watch.ts`, add immediately after the `handleUnwatch` function (before the `// ============== Tail Event Display ==============` banner):

```ts
/** Test seam — clear internal watch + typing state. Do NOT call from app code. */
export function _resetWatchesForTests(): void {
  for (const [, state] of watches) {
    try {
      state.tailer.stop();
    } catch {}
    state.relayCleanup?.();
    if (state.idCheckInterval) clearInterval(state.idCheckInterval);
  }
  watches.clear();
  typingState.clear();
}

/** Test seam — register a pre-built WatchState without starting a tailer. */
export function _registerWatchForTests(state: WatchState): void {
  watches.set(state.chatId, state); // temporary — Task 2 rekeys to composite
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun run test src/__tests__/watch.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck + full test run**

```bash
bun run typecheck
bun run test
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add src/handlers/watch.ts src/__tests__/watch.test.ts
git commit -m "test: add watch handler test seams"
```

---

## Task 2: Core refactor — composite-key map, new signatures, all call sites

This task is the coordinated refactor. It touches all files that consume the watch API so the build stays green. TDD comes in Task 3 (where we add multi-topic isolation tests) and Task 4 (the kill integration test that proves the bug is fixed).

**Files:**

- Modify: `src/handlers/watch.ts`
- Modify: `src/handlers/commands.ts`
- Modify: `src/handlers/text.ts`
- Modify: `src/handlers/relay-bridge.ts`
- Modify: `src/handlers/callback.ts`
- Modify: `src/handlers/index.ts` (barrel exports)
- Modify: `src/index.ts`

### Step 1: `src/handlers/watch.ts` — storage and helpers

- [ ] **1a. Replace map declarations (lines 86-94)**

```ts
// Active watches: "chatId:threadId" -> WatchState
type WatchKey = `${number}:${number}`;
const watches = new Map<WatchKey, WatchState>();

function watchKey(chatId: number, threadId: number): WatchKey {
  return `${chatId}:${threadId}`;
}

// Activity-based typing: starts on events, auto-stops after idle
const TYPING_IDLE_MS = 5_000;
const typingState = new Map<
  WatchKey,
  { running: boolean; timeout: Timer | null }
>();
```

- [ ] **1b. Make `WatchState.threadId` required (line 67-68)**

Change `threadId?: number;` to `threadId: number;`.

- [ ] **1c. Update typing helpers (lines 97-135)**

Replace `touchWatchTyping(botApi, chatId, threadId?)` body to key by `watchKey(chatId, threadId)`, and change `stopWatchTyping(chatId)` signature to `stopWatchTyping(chatId: number, threadId: number)` also keyed by `watchKey(chatId, threadId)`. Update the internal `setTimeout(() => stopWatchTyping(chatId), …)` at line 110 to include `threadId`:

```ts
export function touchWatchTyping(
  botApi: Api,
  chatId: number,
  threadId: number,
): void {
  const key = watchKey(chatId, threadId);
  let entry = typingState.get(key);
  if (!entry) {
    entry = { running: false, timeout: null };
    typingState.set(key, entry);
  }

  if (entry.timeout) clearTimeout(entry.timeout);
  entry.timeout = setTimeout(
    () => stopWatchTyping(chatId, threadId),
    TYPING_IDLE_MS,
  );

  if (entry.running) return;
  entry.running = true;
  const loop = async () => {
    while (entry!.running) {
      try {
        await botApi.sendChatAction(chatId, "typing", {
          message_thread_id: threadId,
        });
      } catch {}
      await Bun.sleep(4000);
    }
  };
  loop();
}

function stopWatchTyping(chatId: number, threadId: number): void {
  const key = watchKey(chatId, threadId);
  const entry = typingState.get(key);
  if (entry) {
    entry.running = false;
    if (entry.timeout) clearTimeout(entry.timeout);
    typingState.delete(key);
  }
}
```

- [ ] **1d. Rewrite `isWatching` and add `isWatchingAny` (line 137-142)**

```ts
/**
 * Check if a specific (chatId, threadId) pair is currently watching.
 * Callers in General chat with no thread should use isWatchingAny instead.
 */
export function isWatching(chatId: number, threadId: number): boolean {
  return watches.has(watchKey(chatId, threadId));
}

/** True if any topic in this chat has an active watch. */
export function isWatchingAny(chatId: number): boolean {
  const prefix = `${chatId}:`;
  for (const k of watches.keys()) {
    if (k.startsWith(prefix)) return true;
  }
  return false;
}
```

- [ ] **1e. Delete `setWatchThreadId` entirely (lines 145-156)**

Remove the export — threadId is now set at construction.

- [ ] **1f. Rewrite `sendWatchRelay` (line 162)**

```ts
export async function sendWatchRelay(
  chatId: number,
  threadId: number,
  username: string,
  text: string,
  opId?: string,
  imagePath?: string,
  sessionOverride?: SessionOverride,
): Promise<boolean> {
  const state = watches.get(watchKey(chatId, threadId));
  if (!state) return false;
  const startedAt = Date.now();

  const target = sessionOverride || state;
  const client = await getRelayClient({
    sessionId: target.sessionId,
    sessionDir: target.sessionDir,
    claudePid: target.sessionPid,
  });
  if (!client) return false;

  client.sendMessage({
    chat_id: String(chatId),
    user: username,
    text,
    ...(imagePath ? { image_path: imagePath } : {}),
  });
  info("watch: relay queued", {
    opId,
    chatId,
    threadId,
    sessionName: state.sessionName,
    sessionId: state.sessionId,
    sessionDir: state.sessionDir,
    durationMs: elapsedMs(startedAt),
  });
  return true;
}
```

- [ ] **1g. Update `cleanupWatch` (lines 204-210)**

```ts
function cleanupWatch(state: WatchState): void {
  state.tailer.stop();
  state.relayCleanup?.();
  if (state.idCheckInterval) clearInterval(state.idCheckInterval);
  stopWatchTyping(state.chatId, state.threadId);
  watches.delete(watchKey(state.chatId, state.threadId));
}
```

(Dropping the now-unused `chatId` parameter — callers pass `state` directly.)

- [ ] **1h. Update `stopWatching` (lines 212-233)**

```ts
export function stopWatching(
  chatId: number,
  threadId: number,
  botApi?: Api,
  reason = "manual",
): WatchState | undefined {
  const state = watches.get(watchKey(chatId, threadId));
  if (state) {
    if (botApi && state.currentTextMsg && !state.segmentDone) {
      finalizeTextMessage(botApi, state);
    }
    cleanupWatch(state);
    info("watch: stopped", {
      chatId,
      threadId,
      sessionName: state.sessionName,
      sessionId: state.sessionId,
      sessionDir: state.sessionDir,
      reason,
    });
  }
  return state;
}
```

- [ ] **1i. Add `stopWatchByDir` below `stopWatching`**

```ts
/**
 * Stop watching the session whose sessionDir matches `sessionDir`.
 * Used by killSession so only the killed session's watch is stopped,
 * leaving other topics' watches intact.
 */
export function stopWatchByDir(
  sessionDir: string,
  botApi?: Api,
  reason = "byDir",
): WatchState | undefined {
  for (const [, state] of watches) {
    if (state.sessionDir === sessionDir) {
      if (botApi && state.currentTextMsg && !state.segmentDone) {
        finalizeTextMessage(botApi, state);
      }
      cleanupWatch(state);
      info("watch: stopped by dir", {
        chatId: state.chatId,
        threadId: state.threadId,
        sessionName: state.sessionName,
        sessionDir,
        reason,
      });
      return state;
    }
  }
  return undefined;
}
```

- [ ] **1j. Update `notifySessionOffline` (lines 239-271)**

Replace the iterator and the call to `cleanupWatch(chatId, state)`:

```ts
export function notifySessionOffline(botApi: Api, sessionDir: string): void {
  for (const [, state] of watches) {
    if (state.sessionDir !== sessionDir) continue;
    const { chatId, threadId } = state;
    cleanupWatch(state);

    const sessionInfo = getSession(state.sessionName);
    if (sessionInfo) {
      session.loadFromRegistry(sessionInfo);
      setActiveSession(state.sessionName);
    }

    botApi
      .sendMessage(
        chatId,
        `📴 <b>${escapeHtml(state.sessionName)}</b> went offline.\nSend a message to continue here.`,
        {
          parse_mode: "HTML",
          ...(threadId ? { message_thread_id: threadId } : {}),
        },
      )
      .catch((err) => warn(`watch offline notify: ${err}`));

    warn("watch: session went offline", {
      chatId,
      threadId,
      sessionName: state.sessionName,
      sessionId: state.sessionId,
      sessionDir,
      readyForResume: Boolean(sessionInfo),
    });
  }
}
```

- [ ] **1k. Rewrite `startAutoWatch` signature and guard (lines 279-363)**

Change signature so `threadId` is required and appears before `sessionName`:

```ts
export async function startAutoWatch(
  botApi: Api,
  chatId: number,
  threadId: number,
  sessionName: string,
): Promise<boolean> {
  // Stop existing watch for THIS (chatId, threadId) if any — don't clobber others.
  if (watches.has(watchKey(chatId, threadId))) {
    stopWatching(chatId, threadId, botApi, "auto-replace");
  }

  await forceRefresh();
  const sessionInfo = getSession(sessionName);
  if (!sessionInfo?.id) {
    warn("auto-watch: start failed, missing session id", {
      chatId,
      threadId,
      sessionName,
    });
    return false;
  }

  const jsonlPath =
    (await findSessionJsonlPath(sessionInfo.id)) ??
    getExpectedJsonlPath(sessionInfo.dir, sessionInfo.id);

  const tailer = new SessionTailer(jsonlPath, (event: TailEvent) => {
    handleTailEvent(botApi, watchState, event, watchState.threadId);
  });
  const watchState: WatchState = {
    sessionName,
    sessionId: sessionInfo.id,
    sessionDir: sessionInfo.dir,
    sessionPid: sessionInfo.pid,
    tailer,
    chatId,
    threadId,
    lastEventTime: Date.now(),
    currentToolMsg: null,
    currentTextMsg: null,
    currentTextContent: "",
    lastTextUpdate: 0,
    segmentDone: true,
  };
  watches.set(watchKey(chatId, threadId), watchState);
  await tailer.start();

  // ... existing relay wiring (lines 326-352) unchanged — it already
  // reads watchState.threadId dynamically ...

  info("auto-watch: started", {
    chatId,
    threadId,
    sessionName,
    sessionId: sessionInfo.id,
    sessionDir: sessionInfo.dir,
  });
  return true;
}
```

- [ ] **1l. Delete `stopAutoWatch` (lines 366-377)**

No remaining callers per the explore report; remove the function.

- [ ] **1m. Rewrite `startWatchingSession` signature and guard (lines 475-540)**

```ts
export async function startWatchingSession(
  botApi: Api,
  chatId: number,
  threadId: number,
  targetName: string,
  reason = "watch",
): Promise<boolean> {
  if (watches.has(watchKey(chatId, threadId))) {
    stopWatching(chatId, threadId, botApi, "replace");
  }

  // ... existing lookup of sessionInfo, jsonlPath (lines 489-511) unchanged ...

  const tailer = new SessionTailer(jsonlPath, (event: TailEvent) => {
    handleTailEvent(botApi, watchState, event, watchState.threadId);
  });
  const watchState: WatchState = {
    sessionName: targetName,
    sessionId: sessionInfo.id,
    sessionDir: sessionInfo.dir,
    sessionPid: sessionInfo.pid,
    tailer,
    chatId,
    threadId,
    lastEventTime: Date.now(),
    currentToolMsg: null,
    currentTextMsg: null,
    currentTextContent: "",
    lastTextUpdate: 0,
    segmentDone: true,
    suppressNextIdChangeNotice: reason === "spawn",
  };
  watches.set(watchKey(chatId, threadId), watchState);
  await tailer.start();

  // Inside idCheckInterval (lines 540-580): the guard at line 541 becomes
  if (!watches.has(watchKey(chatId, threadId))) return;

  // ... rest of startWatchingSession body unchanged ...
}
```

- [ ] **1n. Rewrite `startWatchingAndNotify` (line 638)**

```ts
export async function startWatchingAndNotify(
  ctx: Context,
  chatId: number,
  threadId: number,
  sessionName: string,
  reason = "watch",
): Promise<boolean> {
  const watching = await startWatchingSession(
    ctx.api,
    chatId,
    threadId,
    sessionName,
    reason,
  );
  // ... existing body unchanged ...
}
```

- [ ] **1o. Rewrite `handleWatch` (lines 382-469)**

```ts
export async function handleWatch(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;

  if (!userId || !chatId) return;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (threadId === undefined) {
    await ctx.reply(
      "ℹ️ Watching is per-topic. Use /spawn to create a topic for your session.",
    );
    return;
  }

  if (session.isRunning) {
    await ctx.reply("A query is in progress. Use /stop first.");
    return;
  }

  if (watches.has(watchKey(chatId, threadId))) {
    const existing = watches.get(watchKey(chatId, threadId))!;
    await ctx.reply(
      `Already watching <b>${escapeHtml(existing.sessionName)}</b>. Use /unwatch first.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const text = ctx.message?.text || "";
  const requestedName = text.split(/\s+/)[1];

  let targetName: string | null = null;

  if (requestedName) {
    const sessionInfo = getSession(requestedName);
    if (!sessionInfo) {
      await ctx.reply(
        `Session "${escapeHtml(requestedName)}" not found. Use /list.`,
        { parse_mode: "HTML" },
      );
      return;
    }
    if (sessionInfo.source !== "desktop") {
      await ctx.reply("Can only watch desktop sessions.");
      return;
    }
    targetName = requestedName;
  } else {
    const active = getActiveSession();
    if (active && active.info.source === "desktop") {
      targetName = active.name;
    } else {
      const allSessions = getSessions();
      const desktop = allSessions.find((s) => s.source === "desktop");
      if (desktop) targetName = desktop.name;
    }
  }

  if (!targetName) {
    await ctx.reply(
      "No desktop sessions to watch. Start Claude Code on your desktop first.",
    );
    return;
  }

  const started = await startWatchingAndNotify(
    ctx,
    chatId,
    threadId,
    targetName,
    "command",
  );
  if (!started) {
    await ctx.reply("Could not start watching (no session ID).");
  }
}
```

- [ ] **1p. Rewrite `handleUnwatch` (lines ~693-731)**

```ts
export async function handleUnwatch(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;

  if (!userId || !chatId) return;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (threadId === undefined) {
    await ctx.reply("ℹ️ Unwatching is per-topic.");
    return;
  }

  const state = stopWatching(chatId, threadId, ctx.api, "unwatch");

  if (state) {
    await ctx.reply(
      `Stopped watching <b>${escapeHtml(state.sessionName)}</b>.`,
      { parse_mode: "HTML" },
    );

    const active = getActiveSession();
    const branch = await getGitBranch(session.workingDir);
    updatePinnedStatus(ctx.api, chatId, {
      sessionName: active?.name || null,
      isPlanMode: session.isPlanMode,
      model: session.modelDisplayName,
      branch,
    }).catch(() => {});
  } else {
    await ctx.reply("Not currently watching any session in this topic.");
  }
}
```

- [ ] **1q. Update `_registerWatchForTests` (from Task 1) to use composite key**

```ts
export function _registerWatchForTests(state: WatchState): void {
  watches.set(watchKey(state.chatId, state.threadId), state);
}
```

### Step 2: `src/handlers/index.ts`

- [ ] **2a. Update barrel re-exports**

Search for `setWatchThreadId` and `stopAutoWatch` in `src/handlers/index.ts`. Remove both from the re-export list. Add `isWatchingAny` and `stopWatchByDir` if not already present.

### Step 3: `src/handlers/commands.ts`

- [ ] **3a. Update imports at line 49-51**

Drop `setWatchThreadId` and `stopWatching` from the imports (if present). Add `stopWatchByDir`.

- [ ] **3b. Reorder spawn flow at lines 618-641**

```ts
if (spawned) {
  session.setWorkingDir(spawnCwd);
  setActiveSession(spawned.name);

  // Create topic BEFORE starting the watch so its id is available.
  let topicId: number | undefined;
  if (_topicManager) {
    topicId = await _topicManager
      .createTopic(spawned.name, spawnCwd, spawned.id)
      .catch((err) => {
        warn(`spawn: topic creation failed: ${err}`);
        return undefined;
      });
  }

  if (getAutoWatchOnSpawn() && topicId !== undefined) {
    startWatchingSession(api, chatId, topicId, spawned.name, "spawn").catch(
      () => {},
    );
  }

  await editStatus(
    `✅ <b>${escapeHtml(spawned.name)}</b> ready — watching for updates.`,
  );

  info("spawn: completed", {
    opId,
    chatId,
    userId,
    explicitPath,
    sessionName: spawned.name,
    sessionId: spawned.id,
    durationMs: elapsedMs(spawnStartedAt),
  });
}
```

(Removes the `if (topicId) setWatchThreadId(chatId, topicId);` line entirely.)

- [ ] **3c. Replace the watch teardown in `killSession` at line 763**

Replace:

```ts
stopWatching(chatId, botApi, "kill");
```

with:

```ts
stopWatchByDir(sessionInfo.dir, botApi, "kill");
```

### Step 4: `src/handlers/text.ts`

- [ ] **4a. Update imports**

Remove `setWatchThreadId` from the `./watch` import. Keep `isWatching`, `sendWatchRelay`.

- [ ] **4b. Delete the retrofit block at lines 96-99**

Remove:

```ts
if (isWatching(chatId)) {
  setWatchThreadId(chatId, threadId);
}
```

- [ ] **4c. Update the `sendWatchRelay` call at line 342**

`threadId` is in scope (assigned at line 86). Pass it:

```ts
const relayed = await sendWatchRelay(
  chatId,
  threadId,
  username,
  message,
  opId,
  imagePath,
  sessionOverride,
);
```

### Step 5: `src/handlers/relay-bridge.ts`

- [ ] **5a. Update the gate and call at lines 37-46**

Replace:

```ts
if (isWatching(chatId)) {
  const relayed = await sendWatchRelay(
    chatId,
    username,
    message,
    opId,
    imagePath,
    sessionOverride,
  );
  if (relayed) return "delivered";
}
```

with:

```ts
if (threadId !== undefined && isWatching(chatId, threadId)) {
  const relayed = await sendWatchRelay(
    chatId,
    threadId,
    username,
    message,
    opId,
    imagePath,
    sessionOverride,
  );
  if (relayed) return "delivered";
}
```

(`threadId` is already a parameter of `sendViaRelay` at line 32.)

### Step 6: `src/handlers/callback.ts`

- [ ] **6a. Update import**

Replace `isWatching` in the `./watch` import with `isWatchingAny`. If `isWatching` is used elsewhere in the file (grep before editing), keep both.

- [ ] **6b. Update the gate at line 170**

```ts
if (currentActive.info.source === "desktop" && !isWatchingAny(chatId)) {
```

- [ ] **6c. Update `startWatchingAndNotify` call at line 171**

The switch callback doesn't have a thread — so we cannot start a topic-scoped watch from here. Replace:

```ts
if (await startWatchingAndNotify(ctx, chatId, name, "switch")) {
  await ctx.answerCallbackQuery({ text: `Watching ${name}` });
  return;
}
```

with:

```ts
await ctx.answerCallbackQuery({
  text: `${name} is active — watching is per-topic, use /spawn`,
});
return;
```

### Step 7: `src/index.ts`

- [ ] **7a. Update the two `startAutoWatch` calls at lines 121 and 137 to the new arg order**

```ts
// line 121
if (topicId !== undefined) {
  startAutoWatch(bot.api, chatId, topicId, sessionName).catch(() => {});
}

// line 137
startAutoWatch(bot.api, primaryChatId, topic.topicId, s.name).catch(() => {});
```

### Step 8: Typecheck + full test

- [ ] **8a. Typecheck**

```bash
bun run typecheck
```

Expected: no errors. If errors surface in test files or un-updated callers, grep for `setWatchThreadId`, `stopAutoWatch`, `isWatching(` to find missed sites and update them.

- [ ] **8b. Full test run**

```bash
bun run test
```

Expected: all tests green. The three existing tests in `watch.test.ts` for `isWatching(999999999)` now pass a second `threadId` argument — update them inline:

```ts
test("isWatching returns false for unknown chat", async () => {
  const { isWatching } = await import("../handlers/watch");
  expect(isWatching(999999999, 1)).toBe(false);
});

test("stopWatching returns undefined for unknown chat", async () => {
  const { stopWatching } = await import("../handlers/watch");
  const result = stopWatching(999999999, 1);
  expect(result).toBeUndefined();
});
```

- [ ] **8c. Commit**

```bash
git add src/handlers/watch.ts src/handlers/commands.ts src/handlers/text.ts \
        src/handlers/relay-bridge.ts src/handlers/callback.ts \
        src/handlers/index.ts src/index.ts src/__tests__/watch.test.ts
git commit -m "refactor: watches keyed by (chatId, threadId); multi-topic concurrent"
```

---

## Task 3: Multi-topic isolation unit tests

**Files:**

- Modify: `src/__tests__/watch.test.ts`

- [ ] **Step 1: Write the tests**

Append to `src/__tests__/watch.test.ts`:

```ts
describe("watch: multi-topic isolation", () => {
  const makeState = (
    chatId: number,
    threadId: number,
    sessionDir: string,
  ): any => ({
    chatId,
    threadId,
    sessionName: `s-${threadId}`,
    sessionId: `id-${threadId}`,
    sessionDir,
    currentToolMsg: null,
    currentTextMsg: null,
    currentTextContent: "",
    lastTextUpdate: 0,
    segmentDone: true,
    lastEventTime: Date.now(),
    tailer: { stop: () => {} },
  });

  test("isWatching distinguishes topics under the same chatId", async () => {
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();
    mod._registerWatchForTests(makeState(100, 1, "/repo/a"));

    expect(mod.isWatching(100, 1)).toBe(true);
    expect(mod.isWatching(100, 2)).toBe(false);
  });

  test("isWatchingAny is true while any watch exists for the chat", async () => {
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();

    expect(mod.isWatchingAny(100)).toBe(false);
    mod._registerWatchForTests(makeState(100, 1, "/repo/a"));
    expect(mod.isWatchingAny(100)).toBe(true);
    mod.stopWatching(100, 1);
    expect(mod.isWatchingAny(100)).toBe(false);
  });

  test("stopWatching(chatId, threadId) only removes the target entry", async () => {
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();

    mod._registerWatchForTests(makeState(100, 1, "/repo/a"));
    mod._registerWatchForTests(makeState(100, 2, "/repo/b"));

    mod.stopWatching(100, 1);

    expect(mod.isWatching(100, 1)).toBe(false);
    expect(mod.isWatching(100, 2)).toBe(true);
  });

  test("stopWatchByDir only removes the watch whose sessionDir matches", async () => {
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();

    mod._registerWatchForTests(makeState(100, 1, "/repo/a"));
    mod._registerWatchForTests(makeState(100, 2, "/repo/b"));

    const stopped = mod.stopWatchByDir("/repo/a");

    expect(stopped?.sessionDir).toBe("/repo/a");
    expect(mod.isWatching(100, 1)).toBe(false);
    expect(mod.isWatching(100, 2)).toBe(true);
  });

  test("stopWatchByDir returns undefined for unknown dir", async () => {
    const mod = await import("../handlers/watch");
    mod._resetWatchesForTests();
    expect(mod.stopWatchByDir("/nonexistent/dir")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run**

```bash
bun run test src/__tests__/watch.test.ts
```

Expected: all new tests PASS.

- [ ] **Step 3: Full typecheck + test**

```bash
bun run typecheck
bun run test
```

Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/watch.test.ts
git commit -m "test: multi-topic watch isolation"
```

---

## Task 4: `killSession` integration test

**Files:**

- Modify: `src/__tests__/commands.test.ts`

Goal: prove that `killSession` stops only the watch for the killed session's dir and leaves other topics' watches intact — the bug this refactor fixes.

- [ ] **Step 1: Open and read `src/__tests__/commands.test.ts` to find the existing `killSession` describe block (or create a new one following the file's mock patterns).**

- [ ] **Step 2: Write a failing test**

Append to an appropriate `describe` block (or add a new `describe("killSession: multi-topic", () => { … })`):

```ts
test("killing one session does not stop other topics' watches", async () => {
  const watchMod = await import("../handlers/watch");
  const { killSession } = await import("../handlers/commands");

  watchMod._resetWatchesForTests();

  const mockApi = {
    sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    sendChatAction: mock(() => Promise.resolve()),
  } as any;

  const makeState = (threadId: number, dir: string): any => ({
    chatId: 100,
    threadId,
    sessionName: `s-${threadId}`,
    sessionId: `id-${threadId}`,
    sessionDir: dir,
    sessionPid: 1000 + threadId,
    currentToolMsg: null,
    currentTextMsg: null,
    currentTextContent: "",
    lastTextUpdate: 0,
    segmentDone: true,
    lastEventTime: Date.now(),
    tailer: { stop: mock(() => {}) },
  });

  const stateA = makeState(1, "/repo/a");
  const stateB = makeState(2, "/repo/b");
  watchMod._registerWatchForTests(stateA);
  watchMod._registerWatchForTests(stateB);

  await killSession(
    {
      name: stateB.sessionName,
      dir: stateB.sessionDir,
      pid: stateB.sessionPid,
      id: stateB.sessionId,
      source: "desktop",
    } as any,
    100,
    mockApi,
  );

  // stateB's watch stopped:
  expect(watchMod.isWatching(100, 2)).toBe(false);
  expect(stateB.tailer.stop).toHaveBeenCalled();

  // stateA's watch survives:
  expect(watchMod.isWatching(100, 1)).toBe(true);
  expect(stateA.tailer.stop).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the test**

```bash
bun run test src/__tests__/commands.test.ts
```

Expected: **PASS** (because Task 2 already wired `killSession` to use `stopWatchByDir`). If it fails, it means the wiring regressed — fix `killSession` in `src/handlers/commands.ts:763` to call `stopWatchByDir(sessionInfo.dir, botApi, "kill")`.

If the test fails because `killSession` calls other cleanup (disconnectRelay, process.kill, \_topicManager.deleteTopic) that requires additional mocking, provide minimal stubs for those. Follow existing mock patterns in `commands.test.ts` — they likely already mock these.

- [ ] **Step 4: Full typecheck + test**

```bash
bun run typecheck
bun run test
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/commands.test.ts
git commit -m "test: killSession preserves other topics' watches"
```

---

## Task 5: General-chat rejection test

**Files:**

- Modify: `src/__tests__/watch.test.ts`

- [ ] **Step 1: Write the test**

Append to `src/__tests__/watch.test.ts`:

```ts
describe("handleWatch: General-chat rejection", () => {
  test("rejects when message has no thread", async () => {
    const { handleWatch } = await import("../handlers/watch");
    const replies: string[] = [];
    const ctx = {
      from: { id: 123 },
      chat: { id: 456 },
      message: {}, // no message_thread_id
      reply: (text: string) => {
        replies.push(text);
        return Promise.resolve();
      },
    } as any;

    await handleWatch(ctx);
    expect(replies.length).toBe(1);
    expect(replies[0]).toContain("per-topic");
  });
});
```

- [ ] **Step 2: Run the test**

```bash
bun run test src/__tests__/watch.test.ts
```

Expected: PASS (behavior already wired in Task 2, step 1o).

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/watch.test.ts
git commit -m "test: handleWatch rejects in General chat"
```

---

## Task 6: Final verification

- [ ] **Step 1: Deletion grep**

```bash
grep -RIn "setWatchThreadId" src/
grep -RIn "stopAutoWatch" src/
```

Expected: no matches in `src/` (both were removed).

- [ ] **Step 2: Bare-chatId lookup grep**

```bash
grep -RIn "watches\\.has(chatId)" src/
grep -RIn "watches\\.get(chatId)" src/
grep -RIn "watches\\.set(chatId," src/
grep -RIn "watches\\.delete(chatId)" src/
```

Expected: no matches — every access should now go through `watchKey(...)`.

- [ ] **Step 3: Full typecheck + all tests**

```bash
bun run typecheck
bun run test
```

Expected: both pass.

- [ ] **Step 4: Manual smoke test**

```bash
bun run dev
```

In Telegram:

1. `/spawn` a session in directory A → topic A created, streams updates.
2. `/spawn` another session in directory B → topic B created, streams updates independently.
3. Send a message in topic A → only topic A's stream responds.
4. `/kill` the session in topic B → topic A is still streaming after a follow-up message.
5. `/watch` in General chat → reply contains "per-topic".
6. `/unwatch` in General chat → reply contains "per-topic".

Report PASS/FAIL for each of the six checks. If any FAIL, create a follow-up task; do not silently merge.

- [ ] **Step 5: No-op commit**

Nothing to commit from this task unless smoke-test surfaced a bug.

---

## Task 7: Pre-merge `/simplify` pass

Run `/simplify` over the full branch diff (versus `main`). Three parallel agents review the changes for code reuse, quality, and efficiency. Aggregate findings and fix inline.

- [ ] **Step 1: Run `/simplify` against the branch diff**

```bash
git diff main...HEAD
```

Feed the full diff to `/simplify`. Common issues to watch for on this refactor specifically:

- **Reuse**: any file re-implementing `watchKey()` inline instead of importing it; any helper duplicating `stopWatchByDir`'s linear scan.
- **Quality**: parameter sprawl where `threadId` crept into signatures that didn't need it (only functions that operate on a specific watch need it); stringly-typed `WatchKey` use leaking outside `watch.ts` (should stay encapsulated — external callers pass `(chatId, threadId)` tuples, not `WatchKey` strings).
- **Efficiency**: `isWatchingAny`'s O(n) prefix scan is fine for <20 watches; flag only if some hot path calls it per-message.

- [ ] **Step 2: Apply fixes**

Aggregate findings from the three agents. Fix each issue directly. If a finding is a false positive or out of scope for this refactor, note it and skip.

- [ ] **Step 3: Re-run typecheck + tests after fixes**

```bash
bun run typecheck
bun run test
```

Expected: both pass.

- [ ] **Step 4: Commit (only if fixes were applied)**

```bash
git add <modified files>
git commit -m "refactor: simplify watch refactor per /simplify review"
```

- [ ] **Step 5: Ready to merge**

Branch is now ready. Follow repo's standard merge flow (PR against `main`, etc).
