# Port-File Session Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the relay server's port file the single source of truth for session identity — fixing the multi-session same-directory bug where all sessions share one JSONL and one Telegram topic.

**Architecture:** The relay MCP server discovers its `sessionId` by scanning `~/.claude/projects/` for a JSONL whose birthtime is close to when the relay started. The bot writes `sessionName`, `topicId`, and `topicName` back into the same port file after assigning them. A new `resolveSessionMapping()` function in `src/sessions/mapping.ts` is the canonical resolver — all routing consumers read from it instead of assembling identity from five different files.

**Tech Stack:** Bun, TypeScript, grammy. Tests: `bun:test`. Run: `bun test`. Typecheck: `bun run typecheck`. State dir: `~/.claude-mobile-bridge/`. JSONL dir: `~/.claude/projects/`.

---

## Root Cause

When multiple Claude sessions share a directory, port files have `sessionId: null` (new sessions don't pass `--session-id` on the command line). The watcher falls back to assigning JSONL files by mtime order — but the most actively-used session always has the highest mtime, so every session gets the same JSONL ID, the same auto-watch tailer, and the same Telegram topic.

---

## File Map

| Status | File                                  | Change                                                                           |
| ------ | ------------------------------------- | -------------------------------------------------------------------------------- |
| Modify | `src/mcp/channel-relay/server.ts`     | Add background JSONL birthtime discovery loop; update port file with `sessionId` |
| Modify | `src/relay/discovery.ts`              | Extend `PortFileData` with new optional fields; add `updatePortFile()`           |
| Modify | `src/sessions/watcher.ts`             | Write `sessionName` back to port file after assignment                           |
| Modify | `src/topics/topic-manager.ts`         | Write `topicId` + `topicName` back to port file after create/update              |
| Create | `src/sessions/mapping.ts`             | `resolveSessionMapping(pf)` — canonical resolver                                 |
| Create | `src/__tests__/mapping.test.ts`       | Unit tests for `resolveSessionMapping`                                           |
| Modify | `src/__tests__/topic-manager.test.ts` | Assert `updatePortFile` called after topic creation                              |

---

## Architecture Notes

**Two processes write to the same port file:** the relay server (writes `sessionId`) and the bot (writes `sessionName`, `topicId`, `topicName`). To prevent clobbering, every writer must:

1. Read the current file content
2. Merge its new fields into the parsed object (`{ ...current, ...updates }`)
3. Write back

Each side only writes fields it owns — no field is written by both sides.

**`topicId` is optional.** DM setups never have a `topicId`. All code paths handle `topicId: undefined` gracefully.

**The relay server uses only `node:fs` sync APIs** — no `Bun.sleep` or Bun-specific APIs in `server.ts`.

---

## Task 1: Extend `PortFileData` and add `updatePortFile()`

**Files:**

- Modify: `src/relay/discovery.ts`

- [ ] **Step 1: Run baseline checks**

```bash
bun run typecheck 2>&1 | tail -5
bun test 2>&1 | tail -10
```

Expected: both pass (or only pre-existing failures unrelated to this change).

- [ ] **Step 2: Extend `PortFileData` in `src/relay/discovery.ts`**

Locate the `PortFileData` interface (line 15) and add three new optional fields:

```ts
export interface PortFileData {
  port: number;
  pid: number;
  ppid?: number;
  sessionId?: string;
  cwd: string;
  startedAt: string;
  /** Set by bot after watcher assigns a name. */
  sessionName?: string;
  /** Set by bot after Telegram forum topic is created (group setups only). */
  topicId?: number;
  /** Set by bot after Telegram forum topic is created (group setups only). */
  topicName?: string;
}
```

- [ ] **Step 3: Add `updatePortFile()` to `src/relay/discovery.ts`**

Add the following import at the top of the file (alongside the existing `readFile, readdir, unlink` imports):

```ts
import {
  readFile,
  readdir,
  unlink,
  readFileSync,
  writeFileSync,
} from "fs/promises";
```

Wait — `readFileSync` and `writeFileSync` are from `"fs"` (sync), not `"fs/promises"`. The existing import is `import { readFile, readdir, unlink } from "fs/promises"`. Add a second import for the sync variants:

```ts
import { readFileSync, writeFileSync, readdirSync } from "fs";
```

Then add `updatePortFile` after the `invalidateScanCache` export:

```ts
/**
 * Merge `updates` into the port file for the relay with the given PID.
 * Safe for concurrent use: reads current content before writing, never
 * overwrites fields not present in `updates`.
 *
 * Silently no-ops if the port file cannot be found or parsed.
 */
export function updatePortFile(
  relayPid: number,
  updates: Partial<PortFileData>,
): void {
  let targetFile: string | null = null;
  try {
    const files = readdirSync(STATE_DIR);
    for (const f of files) {
      if (!f.startsWith("channel-relay-") || !f.endsWith(".json")) continue;
      // Port file name format: channel-relay-<hash>-<pid>.json
      const pidPart = f.slice(0, -5).split("-").pop();
      if (pidPart && parseInt(pidPart) === relayPid) {
        targetFile = join(STATE_DIR, f);
        break;
      }
    }
  } catch {
    return;
  }
  if (!targetFile) return;

  try {
    const raw = readFileSync(targetFile, "utf-8");
    const current = JSON.parse(raw) as PortFileData;
    const merged = { ...current, ...updates };
    writeFileSync(targetFile, JSON.stringify(merged, null, 2));
    invalidateScanCache();
  } catch {
    // Malformed file or race — silently skip
  }
}
```

- [ ] **Step 4: Typecheck**

```bash
bun run typecheck 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/relay/discovery.ts
git commit -m "feat(discovery): extend PortFileData with sessionName/topicId/topicName, add updatePortFile()"
```

---

## Task 2: Relay server discovers `sessionId` via JSONL birthtime

**Files:**

- Modify: `src/mcp/channel-relay/server.ts`

The relay server runs inside a Claude process and cannot import from the bot stack. It implements the discovery and file-update logic inline using only `node:fs` sync APIs.

The discovery loop runs in the background after the TCP server binds. Each iteration:

1. Reads all `.jsonl` files from `~/.claude/projects/<cwd-encoded>/`
2. Gets `birthtimeMs` via `statSync`
3. Filters to JSONLs born ≥ 30s before relay started
4. Excludes session IDs already listed in OTHER port files (collision guard)
5. Picks the JSONL with birthtime **closest to `serverStartedAtMs`**
6. Writes `sessionId` to its own port file (merge only)
7. Re-runs every 60s to catch `/clear` and `/respawn` mid-session

- [ ] **Step 1: Add imports to `src/mcp/channel-relay/server.ts`**

The file already has `import { writeFileSync, unlinkSync, mkdirSync } from "fs";`. Replace that line with:

```ts
import {
  writeFileSync,
  unlinkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "fs";
import { homedir } from "os";
```

- [ ] **Step 2: Record server start time (line 28, after `const cwd = process.cwd()`)**

```ts
const serverStartedAtMs = Date.now();
```

- [ ] **Step 3: Add `claudeProjectDir()`, `claimedSessionIds()`, `discoverSessionId()` helpers**

Add after `removePortFile()` (around line 54):

```ts
/** Convert a cwd to the Claude projects directory name (slashes → dashes). */
function claudeProjectDir(workingDir: string): string {
  return join(homedir(), ".claude", "projects", workingDir.replace(/\//g, "-"));
}

/** Collect sessionIds already claimed by OTHER relay port files in STATE_DIR. */
function claimedSessionIds(): Set<string> {
  const claimed = new Set<string>();
  try {
    const files = readdirSync(STATE_DIR);
    for (const f of files) {
      if (!f.startsWith("channel-relay-") || !f.endsWith(".json")) continue;
      // Skip our own port file
      const pidPart = f.slice(0, -5).split("-").pop();
      if (pidPart && parseInt(pidPart) === process.pid) continue;
      try {
        const raw = readFileSync(join(STATE_DIR, f), "utf-8");
        const data = JSON.parse(raw) as { sessionId?: string };
        if (data.sessionId) claimed.add(data.sessionId);
      } catch {
        // Malformed — skip
      }
    }
  } catch {
    // STATE_DIR unreadable
  }
  return claimed;
}

/**
 * Scan ~/.claude/projects/<cwd-hash>/ for a JSONL whose birthtime is closest
 * to serverStartedAtMs and not already claimed by another relay instance.
 * Returns the session UUID or undefined.
 */
function discoverSessionId(): string | undefined {
  const projectDir = claudeProjectDir(cwd);
  const claimed = claimedSessionIds();
  let best: { id: string; diff: number } | undefined;

  try {
    const files = readdirSync(projectDir);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const id = file.slice(0, -6);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        )
      )
        continue;
      if (claimed.has(id)) continue;
      try {
        const s = statSync(join(projectDir, file));
        // Must have been born no earlier than 30s before relay started
        if (s.birthtimeMs < serverStartedAtMs - 30_000) continue;
        const diff = Math.abs(s.birthtimeMs - serverStartedAtMs);
        if (!best || diff < best.diff) best = { id, diff };
      } catch {
        // stat failed — skip
      }
    }
  } catch {
    // projectDir not yet created — JSONL not written yet, will retry
  }

  return best?.id;
}
```

- [ ] **Step 4: Add `updateOwnPortFile()` helper**

Add after `discoverSessionId()`:

```ts
/** Re-read port file, merge `updates`, write back. Never clobbers unrelated fields. */
function updateOwnPortFile(updates: Record<string, unknown>): void {
  try {
    const raw = readFileSync(PORT_FILE, "utf-8");
    const current = JSON.parse(raw) as Record<string, unknown>;
    writeFileSync(
      PORT_FILE,
      JSON.stringify({ ...current, ...updates }, null, 2),
    );
  } catch {
    // Port file removed or malformed — ignore
  }
}
```

- [ ] **Step 5: Add `startSessionIdDiscoveryLoop()`**

Add after `updateOwnPortFile()`:

```ts
const DISCOVERY_RETRY_DELAYS_MS = [3_000, 5_000, 10_000, 20_000, 30_000];

let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
let retryIndex = 0;

function scheduleNextDiscovery(delayMs: number): void {
  if (discoveryTimer) clearTimeout(discoveryTimer);
  discoveryTimer = setTimeout(runDiscovery, delayMs);
}

function runDiscovery(): void {
  discoveryTimer = null;
  const id = discoverSessionId();

  if (id) {
    let currentId: string | undefined;
    try {
      currentId = (
        JSON.parse(readFileSync(PORT_FILE, "utf-8")) as { sessionId?: string }
      ).sessionId;
    } catch {
      return; // Port file gone — stop
    }
    if (id !== currentId) {
      updateOwnPortFile({ sessionId: id });
      process.stderr.write(`channel-relay: discovered sessionId=${id}\n`);
    }
    retryIndex = DISCOVERY_RETRY_DELAYS_MS.length; // switch to 60s steady-state polling
  }

  const delay =
    retryIndex < DISCOVERY_RETRY_DELAYS_MS.length
      ? DISCOVERY_RETRY_DELAYS_MS[retryIndex++]!
      : 60_000;
  scheduleNextDiscovery(delay);
}

function startSessionIdDiscoveryLoop(): void {
  retryIndex = 0;
  scheduleNextDiscovery(DISCOVERY_RETRY_DELAYS_MS[0]!);
}
```

- [ ] **Step 6: Wire into TCP server startup**

In the `tcpServer.listen(0, "127.0.0.1", ...)` callback, add `startSessionIdDiscoveryLoop()` after `writePortFile(addr.port)`:

```ts
tcpServer.listen(0, "127.0.0.1", () => {
  const addr = tcpServer.address();
  if (addr && typeof addr !== "string") {
    writePortFile(addr.port);
    process.stderr.write(
      `channel-relay: listening on port ${addr.port} (${PORT_FILE})\n`,
    );
    startSessionIdDiscoveryLoop();
  }
});
```

- [ ] **Step 7: Stop the loop on cleanup**

```ts
function cleanup(): void {
  if (discoveryTimer) {
    clearTimeout(discoveryTimer);
    discoveryTimer = null;
  }
  removePortFile();
  tcpServer.close();
  if (connectedClient) connectedClient.destroy();
}
```

- [ ] **Step 8: Typecheck**

```bash
bun run typecheck 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/mcp/channel-relay/server.ts
git commit -m "feat(relay-server): background JSONL birthtime discovery — writes sessionId to port file"
```

---

## Task 3: Create `src/sessions/mapping.ts` — canonical resolver

**Files:**

- Create: `src/sessions/mapping.ts`
- Create: `src/__tests__/mapping.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/mapping.test.ts`:

```ts
process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "1";

import { describe, test, expect } from "bun:test";
import type { PortFileData } from "../relay/discovery";

async function loadMapping() {
  return import("../sessions/mapping");
}

const BASE: PortFileData = {
  port: 12345,
  pid: 73988,
  ppid: 73928,
  cwd: "/tmp/projects/foo",
  startedAt: "2026-05-04T15:12:26.609Z",
};

describe("resolveSessionMapping", () => {
  test("returns null when sessionId is absent", async () => {
    const { resolveSessionMapping } = await loadMapping();
    expect(resolveSessionMapping({ ...BASE })).toBeNull();
  });

  test("returns null when sessionName is absent", async () => {
    const { resolveSessionMapping } = await loadMapping();
    expect(
      resolveSessionMapping({
        ...BASE,
        sessionId: "0111828c-21b2-4a3b-9999-000000000001",
      }),
    ).toBeNull();
  });

  test("returns full mapping when sessionId and sessionName present", async () => {
    const { resolveSessionMapping } = await loadMapping();
    const pf: PortFileData = {
      ...BASE,
      sessionId: "0111828c-21b2-4a3b-9999-000000000001",
      sessionName: "foo-2",
    };
    const result = resolveSessionMapping(pf);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("0111828c-21b2-4a3b-9999-000000000001");
    expect(result!.sessionName).toBe("foo-2");
    expect(result!.relayPid).toBe(73988);
    expect(result!.relayPort).toBe(12345);
    expect(result!.claudePid).toBe(73928);
    expect(result!.cwd).toBe("/tmp/projects/foo");
    expect(result!.topicId).toBeUndefined();
    expect(result!.topicName).toBeUndefined();
  });

  test("includes topicId and topicName when present (group setup)", async () => {
    const { resolveSessionMapping } = await loadMapping();
    const result = resolveSessionMapping({
      ...BASE,
      sessionId: "0111828c-21b2-4a3b-9999-000000000002",
      sessionName: "foo",
      topicId: 26248,
      topicName: "foo",
    });
    expect(result!.topicId).toBe(26248);
    expect(result!.topicName).toBe("foo");
  });

  test("topicId absent for DM setup", async () => {
    const { resolveSessionMapping } = await loadMapping();
    const result = resolveSessionMapping({
      ...BASE,
      sessionId: "0111828c-21b2-4a3b-9999-000000000003",
      sessionName: "foo",
    });
    expect(result!.topicId).toBeUndefined();
    expect(result!.topicName).toBeUndefined();
  });

  test("claudePid is undefined when ppid absent", async () => {
    const { resolveSessionMapping } = await loadMapping();
    const pf: PortFileData = {
      port: 12345,
      pid: 73988,
      cwd: "/p",
      startedAt: "2026-05-04T00:00:00Z",
      sessionId: "0111828c-21b2-4a3b-9999-000000000004",
      sessionName: "foo",
    };
    expect(resolveSessionMapping(pf)!.claudePid).toBeUndefined();
  });
});
```

Run to confirm failure:

```bash
bun test src/__tests__/mapping.test.ts 2>&1 | tail -10
```

Expected: `FAIL` — module not found.

- [ ] **Step 2: Create `src/sessions/mapping.ts`**

```ts
import type { PortFileData } from "../relay/discovery";

export interface SessionMapping {
  /** PID of the desktop Claude process (ppid of the relay). */
  claudePid: number | undefined;
  /** PID of the relay MCP server process. */
  relayPid: number;
  /** TCP port the relay server is listening on. */
  relayPort: number;
  /** Claude session UUID (discovered by relay via JSONL birthtime). */
  sessionId: string;
  /** Human-friendly session name assigned by the bot watcher. */
  sessionName: string;
  /** Telegram message_thread_id — absent for DM setups. */
  topicId?: number;
  /** Telegram forum topic name — absent for DM setups. */
  topicName?: string;
  /** Working directory of the Claude session. */
  cwd: string;
}

/**
 * Convert a port file into a fully-resolved SessionMapping.
 *
 * Returns null when the port file has not yet been fully populated
 * (sessionId or sessionName still missing — relay/watcher still catching up).
 * Callers should re-scan port files and retry after a short delay.
 */
export function resolveSessionMapping(pf: PortFileData): SessionMapping | null {
  if (!pf.sessionId || !pf.sessionName) return null;

  return {
    claudePid: pf.ppid,
    relayPid: pf.pid,
    relayPort: pf.port,
    sessionId: pf.sessionId,
    sessionName: pf.sessionName,
    topicId: pf.topicId,
    topicName: pf.topicName,
    cwd: pf.cwd,
  };
}
```

- [ ] **Step 3: Run tests**

```bash
bun test src/__tests__/mapping.test.ts 2>&1 | tail -15
```

Expected: all 6 tests pass.

- [ ] **Step 4: Typecheck**

```bash
bun run typecheck 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/mapping.ts src/__tests__/mapping.test.ts
git commit -m "feat(mapping): add resolveSessionMapping() — canonical port-file-to-identity resolver"
```

---

## Task 4: Watcher writes `sessionName` back to port file

**Files:**

- Modify: `src/sessions/watcher.ts`

After the session cache is rebuilt in `refresh()`, find each desktop session's relay PID and write its assigned name back to the port file.

- [ ] **Step 1: Add `updatePortFile` import to `src/sessions/watcher.ts`**

Locate the import of `scanPortFiles, invalidateScanCache` from `"../relay/discovery"` and add `updatePortFile`:

```ts
import {
  scanPortFiles,
  invalidateScanCache,
  updatePortFile,
} from "../relay/discovery";
```

- [ ] **Step 2: Add sessionName write-back at end of `refresh()`**

In `refresh()`, the function already has `const { sessions: discovered, portFiles } = await scanSessions();` near the top. At the very end of `refresh()`, just before `return { added, removed };`, add:

```ts
// Write each desktop session's assigned name back to its relay port file.
// This makes the port file the single source of truth for session identity.
const relayPidBySessionId = new Map<string, number>();
const relayPidByDirPpid = new Map<string, number>();
for (const pf of portFiles) {
  if (pf.sessionId) relayPidBySessionId.set(pf.sessionId, pf.pid);
  if (pf.ppid) relayPidByDirPpid.set(`${pf.cwd}\0${pf.ppid}`, pf.pid);
}
for (const si of cache.sessions.values()) {
  if (si.source !== "desktop" || !si.name) continue;
  const relayPid =
    (si.id ? relayPidBySessionId.get(si.id) : undefined) ??
    (si.pid !== undefined
      ? relayPidByDirPpid.get(`${si.dir}\0${si.pid}`)
      : undefined);
  if (relayPid !== undefined) {
    updatePortFile(relayPid, { sessionName: si.name });
  }
}
```

- [ ] **Step 3: Run tests and typecheck**

```bash
bun test 2>&1 | tail -10
bun run typecheck 2>&1 | tail -5
```

Expected: all pass, clean.

- [ ] **Step 4: Commit**

```bash
git add src/sessions/watcher.ts
git commit -m "feat(watcher): write sessionName back to port file after assignment"
```

---

## Task 5: Topic manager writes `topicId` + `topicName` back to port file

**Files:**

- Modify: `src/topics/topic-manager.ts`
- Modify: `src/__tests__/topic-manager.test.ts`

- [ ] **Step 1: Add imports to `src/topics/topic-manager.ts`**

```ts
import { scanPortFiles, updatePortFile } from "../relay/discovery";
```

- [ ] **Step 2: Add `findRelayPid()` private helper to `TopicManager`**

Add inside the class body:

```ts
private async findRelayPid(
  sessionName: string,
  sessionDir: string,
  sessionId?: string,
): Promise<number | undefined> {
  const portFiles = await scanPortFiles();
  if (sessionId) {
    const pf = portFiles.find((p) => p.sessionId === sessionId);
    if (pf) return pf.pid;
  }
  const byName = portFiles.find((p) => p.sessionName === sessionName);
  if (byName) return byName.pid;
  const byDir = portFiles.filter((p) => p.cwd === sessionDir);
  if (byDir.length === 1) return byDir[0]!.pid;
  return undefined;
}
```

- [ ] **Step 3: Write failing test**

In `src/__tests__/topic-manager.test.ts`, add a mock for discovery and a test:

At the top of the file add:

```ts
import { mock } from "bun:test";
const mockUpdatePortFile = mock((_pid: number, _updates: object) => {});

mock.module("../relay/discovery", () => ({
  scanPortFiles: mock(async () => [
    {
      port: 9999,
      pid: 11111,
      ppid: 22222,
      cwd: "/tmp/proj",
      startedAt: "2026-05-04T00:00:00.000Z",
      sessionId: "sid-1",
      sessionName: "my-session",
    },
  ]),
  updatePortFile: mockUpdatePortFile,
  isRelayProcess: () => true,
  invalidateScanCache: () => {},
}));
```

Add test inside `describe("TopicManager", ...)`:

```ts
test("createTopic writes topicId and topicName back to port file", async () => {
  mockUpdatePortFile.mockClear();
  const mgr = createManager();
  await mgr.createTopic("my-session", "/tmp/proj", "sid-1");
  expect(mockUpdatePortFile).toHaveBeenCalledTimes(1);
  const [pid, updates] = mockUpdatePortFile.mock.calls[0]!;
  expect(pid).toBe(11111);
  expect((updates as Record<string, unknown>).topicId).toBeDefined();
  expect((updates as Record<string, unknown>).topicName).toBe("my-session");
});
```

Run to confirm failure:

```bash
bun test src/__tests__/topic-manager.test.ts 2>&1 | tail -10
```

Expected: new test fails — `updatePortFile` not yet called.

- [ ] **Step 4: Add write-back calls in `createTopic`**

In `src/topics/topic-manager.ts`, in `createTopic`:

**Reuse path** — after `updateTopicMapping(sessionName, { isOnline: true, sessionId })`:

```ts
const reusePid = await this.findRelayPid(sessionName, sessionDir, sessionId);
if (reusePid !== undefined) {
  updatePortFile(reusePid, {
    topicId: existing.topicId,
    topicName: sessionName,
  });
}
```

**New topic path** — after `addTopicMapping({ topicId, sessionName, ... })`:

```ts
const newPid = await this.findRelayPid(sessionName, sessionDir, sessionId);
if (newPid !== undefined) {
  updatePortFile(newPid, { topicId, topicName: sessionName });
}
```

- [ ] **Step 5: Run tests**

```bash
bun test src/__tests__/topic-manager.test.ts 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 6: Run full suite and typecheck**

```bash
bun run typecheck 2>&1 | tail -5
bun test 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/topics/topic-manager.ts src/__tests__/topic-manager.test.ts
git commit -m "feat(topic-manager): write topicId+topicName back to port file after topic creation"
```

---

## Task 6: Final validation

- [ ] **Step 1: Verify all writers call `updatePortFile`**

```bash
grep -rn "updatePortFile" src/ --include="*.ts"
```

Expected: `discovery.ts` (definition), `watcher.ts` (import + call), `topic-manager.ts` (import + 2 calls).

- [ ] **Step 2: Full test suite**

```bash
bun test 2>&1 | tail -15
```

Expected: all pass. If `web-tasks-watcher.test.ts` flakes (known timing issue), re-run once.

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck 2>&1
```

Expected: zero errors.

- [ ] **Step 4: Manual smoke test with two sessions**

Start two Claude sessions in the same directory, wait ~10s, then inspect port files:

```bash
cat ~/.claude-mobile-bridge/channel-relay-*.json | python3 -c "
import json, sys, re
data = sys.stdin.read()
for block in re.split(r'\n(?=\{)', data.strip()):
    try:
        d = json.loads(block)
        if 'claude-mobile-bridge' in d.get('cwd',''):
            print(f\"pid={d['pid']} sessionId={d.get('sessionId','MISSING')} sessionName={d.get('sessionName','MISSING')} topicId={d.get('topicId','MISSING')}\")
    except: pass
"
```

Expected: two lines with **distinct** `sessionId` values, each with a `sessionName` and `topicId` set.

- [ ] **Step 5: Final commit if any cleanup was needed**

```bash
git add -p
git commit -m "fix: final cleanup after port-file session mapping validation"
```

---

## Implementation Notes

### Why birthtime, not mtime

`birthtimeMs` is set once when Claude creates the JSONL. `mtimeMs` changes on every write — the most actively-used session always has the highest mtime, which is the exact bug this fixes.

macOS (APFS) supports `birthtimeMs` accurately. On Linux filesystems without birthtime, `birthtimeMs` falls back to `ctimeMs` (inode change time), still more stable than mtime for a freshly-created file.

### `/clear` and `/respawn` mid-session

These Claude commands create a new JSONL without restarting the relay server. The discovery loop's steady-state 60s poll handles this: the new JSONL has a birthtime after `serverStartedAtMs`, so the loop picks it up and updates the port file. The watcher's `STATE_DIR` watch then triggers a refresh, propagating the new `sessionId` to the session cache.

### The 30-second lookback window

`birthtime >= serverStartedAtMs - 30_000` handles clock skew between when the relay server starts and when Claude writes its first JSONL entry (typically 1–2 seconds). The 30-second window is generous.

### Collision guard for simultaneous sessions

Before claiming a JSONL, `claimedSessionIds()` reads every other port file in `STATE_DIR` and skips already-claimed session IDs. If two relays start within the same second, one will run its first discovery pass slightly before the other. The first relay claims a JSONL and writes the port file; the second relay's `claimedSessionIds()` then sees that entry and skips it, claiming the next available JSONL instead.

### `topicId` is optional

DM setups have no Telegram threads. `topicId` and `topicName` are simply absent from port files in that configuration. `resolveSessionMapping` exposes them as optional fields; callers that need `topicId` must handle `undefined`.

---

## Self-Review

**Spec coverage:**

- Relay server discovers `sessionId` via JSONL birthtime: Task 2 ✓
- Bot writes `sessionName` back to port file: Task 4 ✓
- Bot writes `topicId`/`topicName` back to port file: Task 5 ✓
- `resolveSessionMapping()` is the canonical resolver: Task 3 ✓
- `PortFileData` extended with new optional fields: Task 1 ✓
- `updatePortFile()` is the single write-back entry: Task 1 ✓
- Port file writes are atomic (merge not overwrite): Tasks 1, 2, 4, 5 ✓
- `topicId` is optional (DM setups work): Task 3 tests + Task 5 implementation ✓
- Relay server uses only `node:fs` sync APIs: Task 2 ✓
- All existing tests continue to pass: Task 6 ✓
- No JSONL mtime fallback regressions: Task 4 does not remove the fallback — it supplements it. The fallback still works when `sessionId` is not yet populated. ✓

**Placeholder scan:** No TBDs, no TODOs, no "implement later". All code blocks are complete.

**Type consistency:**

- `PortFileData.sessionName?: string` — defined Task 1, used in Tasks 2, 4, 5
- `PortFileData.topicId?: number` — defined Task 1, used in Tasks 3, 5
- `PortFileData.topicName?: string` — defined Task 1, used in Tasks 3, 5
- `updatePortFile(relayPid: number, updates: Partial<PortFileData>)` — defined Task 1, called in Tasks 4 and 5 with matching argument types
- `resolveSessionMapping(pf: PortFileData): SessionMapping | null` — defined Task 3, types consistent throughout
- `SessionMapping.claudePid: number | undefined` — Task 3 definition matches Task 3 test assertions
