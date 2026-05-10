# Tailer & Session Sync Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three bugs causing Claude session output to silently disappear from Telegram: dropped assistant messages, duplicate-cwd sessions sharing one sessionId, and relay-less watches starting without any user notice.

**Architecture:** All three fixes are surgical — one condition change in `tailer.ts`, one loop refactor in `watcher.ts`, one code block added to `watch.ts`. No new files. No refactoring beyond the bug sites.

**Tech Stack:** Bun, TypeScript, grammyjs, existing test suite in `src/__tests__/`

---

## Files Modified

- `src/sessions/tailer.ts:440` — extend assistant-message condition to also handle `message`-format JSONL
- `src/sessions/watcher.ts:364-382` — assign distinct fallback sessionIds to each port file for same dir
- `src/handlers/watch.ts:781` — send one-time notice when auto-watch starts without a relay
- `src/__tests__/tailer.test.ts` — add test case for `message`-format assistant events

---

## Task 1: Fix tailer dropping `message`-format assistant events

**Context:** Some sessions write JSONL where assistant responses have no top-level `type` field. The entry looks like `{ parentUuid, isSidechain, message: { role: "assistant", content: [...] } }`. The tailer only checks `entry.type === "assistant"` (line 440 of `tailer.ts`), so these entries fall through and return `[]` — Claude's entire output is silently dropped.

**Files:**

- Modify: `src/sessions/tailer.ts:440`
- Modify: `src/__tests__/tailer.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe("tailer: parseLine", ...)` block in `src/__tests__/tailer.test.ts`:

```typescript
test("parses message-format assistant text block (no top-level type)", () => {
  const line = JSON.stringify({
    parentUuid: "abc123",
    isSidechain: false,
    message: {
      model: "claude-opus-4-7",
      id: "msg_01abc",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello from message format" }],
    },
  });

  const events = tailer.parseLine(line);
  expect(events).toHaveLength(2);
  expect(events[0]!.type).toBe("text");
  expect(events[0]!.content).toBe("Hello from message format");
  expect(events[1]!.type).toBe("turn_end");
});

test("parses message-format assistant tool_use block (no top-level type)", () => {
  const line = JSON.stringify({
    parentUuid: "abc123",
    isSidechain: false,
    message: {
      model: "claude-opus-4-7",
      id: "msg_01abc",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool_1",
          name: "Read",
          input: { file_path: "/tmp/test.ts" },
        },
      ],
    },
  });

  const events = tailer.parseLine(line);
  expect(events).toHaveLength(1);
  expect(events[0]!.type).toBe("tool");
  expect(events[0]!.content).toContain("Reading");
});

test("parses message-format assistant thinking block (no top-level type)", () => {
  const line = JSON.stringify({
    parentUuid: "abc123",
    isSidechain: false,
    message: {
      model: "claude-opus-4-7",
      id: "msg_01abc",
      type: "message",
      role: "assistant",
      content: [{ type: "thinking", thinking: "Let me reason..." }],
    },
  });

  const events = tailer.parseLine(line);
  expect(events).toHaveLength(2);
  expect(events[0]!.type).toBe("thinking");
  expect(events[1]!.type).toBe("turn_end");
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd <repo>
bun test src/__tests__/tailer.test.ts 2>&1 | grep -E "FAIL|PASS|message-format"
```

Expected: 3 failures — `parses message-format assistant text block`, `parses message-format assistant tool_use block`, `parses message-format assistant thinking block`

- [ ] **Step 3: Extend the assistant condition in tailer.ts**

In `src/sessions/tailer.ts`, change line 440 from:

```typescript
      // Assistant message — emit all blocks
      if (entry.type === "assistant") {
        const content = entry.message?.content;
```

To:

```typescript
      // Assistant message — emit all blocks.
      // Supports both {type:"assistant", message:{content:[]}} and
      // {message:{role:"assistant", content:[]}} (message-format JSONL).
      if (entry.type === "assistant" || entry.message?.role === "assistant") {
        const content = entry.message?.content;
```

No other changes needed — `entry.message?.content` already works for both formats.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test src/__tests__/tailer.test.ts 2>&1 | grep -E "FAIL|PASS|message-format|✓|✗"
```

Expected: all tests pass including the 3 new ones.

- [ ] **Step 5: Run full test suite to check for regressions**

```bash
bun test 2>&1 | tail -20
```

Expected: no failures introduced.

- [ ] **Step 6: Commit**

```bash
git add src/sessions/tailer.ts src/__tests__/tailer.test.ts
git commit -m "fix(tailer): handle message-format assistant events (no top-level type field)"
```

---

## Task 2: Fix duplicate-cwd sessions collapsing to same sessionId

**Context:** When two Claude processes run in the same directory, two port files exist for that dir. Neither port file carries a `sessionId` field. The current code uses `mostRecentJsonlId` as fallback for **every** port file — so both sessions get the same ID, both topics watch the same JSONL, and duplicate content streams to Telegram.

The fix: build a list of unused JSONL candidates for the dir and consume them sequentially — first port file gets the most-recent JSONL session, second gets the next one.

**Files:**

- Modify: `src/sessions/watcher.ts:364-382`

- [ ] **Step 1: Read the existing loop to understand the exact replacement**

Current code at `src/sessions/watcher.ts:364-382`:

```typescript
// 1. Add port-file sessions (authoritative, have PIDs)
const pfs = portsByDir.get(dir) || [];
for (const pf of pfs) {
  if (dirFound.length >= processCount) break;
  if (pf.sessionId && knownIds.has(pf.sessionId)) continue;
  // If port file has no sessionId, fall back to most recent JSONL for this dir
  const resolvedId = pf.sessionId || mostRecentJsonlId;
  dirFound.push({
    id: resolvedId,
    name: "",
    dir,
    lastActivity:
      jsonlMtime.get(resolvedId) ??
      (pf.startedAt ? new Date(pf.startedAt).getTime() : Date.now()),
    source: "desktop",
    pid: pf.ppid,
  });
  if (resolvedId) knownIds.add(resolvedId);
}
```

- [ ] **Step 2: Replace the loop with sequential fallback assignment**

Replace the block above with:

```typescript
// 1. Add port-file sessions (authoritative, have PIDs).
// When a port file has no sessionId, consume JSONL candidates sequentially
// so two port files for the same dir get distinct IDs rather than both
// falling back to mostRecentJsonlId.
const pfs = portsByDir.get(dir) || [];
const unusedFallbacks = candidates
  .filter((c) => c.info.id && !knownIds.has(c.info.id))
  .map((c) => c.info.id);
let fallbackIdx = 0;
for (const pf of pfs) {
  if (dirFound.length >= processCount) break;
  if (pf.sessionId && knownIds.has(pf.sessionId)) continue;
  const resolvedId = pf.sessionId || unusedFallbacks[fallbackIdx++] || "";
  dirFound.push({
    id: resolvedId,
    name: "",
    dir,
    lastActivity:
      jsonlMtime.get(resolvedId) ??
      (pf.startedAt ? new Date(pf.startedAt).getTime() : Date.now()),
    source: "desktop",
    pid: pf.ppid,
  });
  if (resolvedId) knownIds.add(resolvedId);
}
```

- [ ] **Step 3: Run the full test suite**

```bash
bun test 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 4: Verify the fix manually**

Check that the existing two `claude-mobile-bridge` port files would now get distinct IDs:

```bash
cat /tmp/channel-relay-*.json | python3 -c "
import json, sys
data = sys.stdin.read()
import re
files = re.findall(r'\{[^}]+\}', data)
for f in files:
    try:
        d = json.loads(f)
        print(f'pid={d.get(\"pid\")} cwd={d.get(\"cwd\",\"\").split(\"/\")[-1]} sessionId={d.get(\"sessionId\",\"NONE\")}')
    except: pass
"
```

Port files without `sessionId` confirm the fallback path is needed. After the fix, the watcher would assign each a different JSONL session on startup.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/watcher.ts
git commit -m "fix(watcher): assign distinct sessionIds to duplicate-cwd port files"
```

---

## Task 3: Warn in Telegram when auto-watch starts without relay

**Context:** When `getRelayClient` returns null (no relay port file matches the session), the auto-watch starts silently. After Task 1's fix, Claude→Telegram output now works. But the user can't send messages back to Claude — and they get no indication of this. The fix sends one notice to the topic on watch startup when relay is absent.

**Files:**

- Modify: `src/handlers/watch.ts:781` (after the closing `}` of the `if (relayClient)` block)

- [ ] **Step 1: Add the relay-less notice after the existing relay wiring block**

In `src/handlers/watch.ts`, find the block ending at line 781:

```typescript
  if (relayClient) {
    const scopeChatId = String(chatId);
    const onReply = (msg: RelayReply) => {
      // ... relay reply handling ...
    };
    relayClient.onReply(onReply, scopeChatId);
    watchState.relayCleanup = () => relayClient.offReply(onReply);
  }

  info("auto-watch: started", {
```

Change to:

```typescript
  if (relayClient) {
    const scopeChatId = String(chatId);
    const onReply = (msg: RelayReply) => {
      // ... relay reply handling ...
    };
    relayClient.onReply(onReply, scopeChatId);
    watchState.relayCleanup = () => relayClient.offReply(onReply);
  } else {
    sendTextReply(
      botApi,
      chatId,
      `👁 Watching output only — no relay connection for _${sessionName}_. Claude's responses will appear here but messages you send won't reach Claude until the relay reconnects.`,
      threadId,
    );
  }

  info("auto-watch: started", {
```

`sendTextReply` is already imported at line 49 of `watch.ts`. `threadId`, `chatId`, `botApi`, and `sessionName` are all in scope.

- [ ] **Step 2: Run the full test suite**

```bash
bun test 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/handlers/watch.ts
git commit -m "feat(watch): notify topic when auto-watch starts without relay connection"
```

---

## Self-Review

**Spec coverage:**

- Bug 1 (tailer drops message-format): ✓ Task 1 — condition extended, 3 tests added
- Bug 2 (duplicate-cwd same sessionId): ✓ Task 2 — sequential fallback assignment
- Bug 3 (relay-less watch silent): ✓ Task 3 — one-time notice via `sendTextReply`
- Test requirement for Bug 1: ✓ Task 1 Steps 1-4

**Placeholder scan:** No TBDs, no "implement later", all code blocks complete.

**Type consistency:** `sendTextReply(botApi, chatId, text, threadId?)` used correctly. `unusedFallbacks` is `string[]`. `fallbackIdx` is `number`. All consistent.
