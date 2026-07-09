# Identity P2 — Hook-Minted launchUuid + Registry (writer side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every hook-bearing Claude session a stable `launchUuid` minted by the SessionStart hook (keyed on the Claude process's pid + start-time), persisted to a registry, and exposed to `resolveSession` — **observe-only** (nothing routes on it or is deleted yet).

**Architecture:** The SessionStart hook, on first fire for a Claude process, mints a `launchUuid` keyed on `(claudePid, startTime)` and writes a per-session file `~/.claude-mobile-bridge/registry/<launchUuid>.json`; on later fires (`/clear`/resume) it finds that record and re-anchors the rolling `sessionId`. The bot reads the registry dir into the resolve snapshot, and a shadow logs where a `launchUuid`-based resolution _would_ differ from today's — proving the registry is trustworthy before P3 migrates any consumer.

**Tech Stack:** Bun + TypeScript. The hook is a standalone `bun` script (symlinked into `~/.claude/hooks`) that **cannot import repo modules** — its logic lives in `hooks/claude-remote-session-id.ts` with exported pure functions for tests. The bot-side reader is a normal repo module.

## Global Constraints

- **Purely additive / observe-only.** P2 changes NO routing outcome and deletes NOTHING. The hook's existing port-file `sessionId` write stays; the registry write is added alongside it. `resolveSession`'s current behavior is unchanged; the `launchUuid` path is populated but only shadowed.
- **Registry location:** `${CLAUDE_TELEGRAM_STATE_DIR:-~/.claude-mobile-bridge}/registry/<launchUuid>.json`, one file per session (avoids concurrent-write races when multiple sessions `/clear` at once — mirrors the port-file-per-session pattern).
- **Stable key:** `launchUuid` is keyed on `(claudePid, startTime)` where `claudePid` is the Claude process (the port file's `ppid` / the `claude`-named ancestor) and `startTime` is `ps -o lstart` of that pid. Pid+startTime together so OS pid-reuse can't collide.
- **Record shape** (`RegistryRecord`): `{ launchUuid: string; claudePid: number; startTime: string; sessionId: string; cwd: string; source: string; updatedAt: string }`.
- **Hook hard rules (unchanged):** never write stdout; always `exit 0`; stay fast (sync `ps` + readdir only); a throw must never break session start (the registry write is wrapped so a failure is logged and swallowed).
- **Hook cannot import from `src/`** — repeat/duplicate any needed helper inside `hooks/claude-remote-session-id.ts`.
- Test runner: `bun test`. Run one file: `bun test path/to/file.test.ts`. The full pre-commit suite is occasionally flaky (an unrelated SSE-timeout test) — a commit that fails the hook once may pass on immediate retry.
- Work happens on local `main` (push-protected; commits are local until a branch/PR later).

---

## File Structure

- **Modify `hooks/claude-remote-session-id.ts`** — add exported pure `deriveClaudePid(ancestry, commOf, portFilePpid)`, `mintDecision(existing, claudePid, startTime, sessionId, cwd, source, newUuid)`, and the IO to write `registry/<launchUuid>.json`. The mint runs BEFORE the port-file bails (race-free — derived from the process tree, not the port file), in its own try/catch.
- **Create `src/sessions/registry.ts`** — bot-side reader: `readRegistry()` → `RegistryRecord[]`, plus pure `indexByClaudePid` / `findByLaunchUuid`. One responsibility: load + index the registry dir.
- **Modify `src/sessions/resolve-session.ts`** — extend `ResolveSnapshot`/`SessionRecord` to carry `launchUuid`; make the `by:"launchId"` branch resolve from it. (`Handle` already has the variant.)
- **Modify `src/sessions/identity-shadow.ts`** — add `shadowLaunchUuid(...)`: given a session with both a registry `launchUuid` and today's resolved id, log a divergence if resolving `by:launchId` disagrees with resolving `by:sessionId`.
- **Modify `src/sessions/watcher.ts`** — in the refresh, read the registry and attach `launchUuid` to the snapshot; call the shadow. Observe-only.

Task order: process-identity primitives → registry writer (hook) → registry reader (bot) → resolver `launchUuid` path → wire + shadow.

---

### Task 1: Process-identity primitives in the hook (`claudePid` + `startTime`)

**Files:**

- Modify: `hooks/claude-remote-session-id.ts`
- Test: `hooks/claude-remote-session-id.test.ts` (append)

**Interfaces:**

- Produces:
  - `deriveClaudePid(ancestry: number[], commOf: (pid:number)=>string|undefined, portFilePpid?: number): number | undefined` — pure. If `portFilePpid` is in `ancestry`, return it (the relay's parent IS Claude). Else return the closest ancestor whose `commOf` is exactly `"claude"`. Else `undefined`.
  - `startTimeOf(pid: number): string` — `ps -o lstart= -p <pid>` trimmed; `""` on failure. (IO; not unit-tested — exercised via the mint IO.)

- [ ] **Step 1: Write the failing test**

Append to `hooks/claude-remote-session-id.test.ts`:

```ts
import { deriveClaudePid } from "./claude-remote-session-id";

test("deriveClaudePid prefers the port file's ppid when it's an ancestor", () => {
  const ancestry = [200, 300, 1]; // parent, grandparent, init
  const comm = (_p: number) => "bun";
  expect(deriveClaudePid(ancestry, comm, 300)).toBe(300);
});

test("deriveClaudePid falls back to the closest 'claude'-named ancestor", () => {
  const ancestry = [200, 300, 400];
  const comm = (p: number) => (p === 300 ? "claude" : "bash");
  expect(deriveClaudePid(ancestry, comm, undefined)).toBe(300);
});

test("deriveClaudePid ignores a portFilePpid that isn't in the ancestry", () => {
  const ancestry = [200, 300];
  const comm = (p: number) => (p === 200 ? "claude" : "bash");
  expect(deriveClaudePid(ancestry, comm, 999)).toBe(200);
});

test("deriveClaudePid returns undefined when nothing matches", () => {
  expect(deriveClaudePid([200, 300], () => "bash", undefined)).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test hooks/claude-remote-session-id.test.ts`
Expected: FAIL — `deriveClaudePid` is not exported.

- [ ] **Step 3: Implement**

Add to `hooks/claude-remote-session-id.ts` (near the other exported pure logic):

```ts
/**
 * The Claude process pid for this hook. Prefer the relay port file's ppid when
 * it's a known ancestor (the relay is Claude's child, so its ppid IS Claude).
 * Otherwise fall back to the closest ancestor whose command is exactly "claude".
 */
export function deriveClaudePid(
  ancestry: number[],
  commOf: (pid: number) => string | undefined,
  portFilePpid?: number,
): number | undefined {
  if (portFilePpid !== undefined && ancestry.includes(portFilePpid)) {
    return portFilePpid;
  }
  for (const pid of ancestry) {
    if (commOf(pid) === "claude") return pid;
  }
  return undefined;
}
```

And the IO helper (near the other `execSync`/`ps` uses):

```ts
/** Process start timestamp (`ps -o lstart`), used with the pid as a stable key. */
function startTimeOf(pid: number): string {
  try {
    return execSync(`ps -o lstart= -p ${pid}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test hooks/claude-remote-session-id.test.ts`
Expected: PASS (4 new tests).

- [ ] **Step 5: Commit**

```bash
git add hooks/claude-remote-session-id.ts hooks/claude-remote-session-id.test.ts
git commit -m "feat(identity-p2): hook process-identity primitives (deriveClaudePid + startTimeOf)"
```

---

### Task 2: Mint decision (pure) + registry write (hook)

**Files:**

- Modify: `hooks/claude-remote-session-id.ts`
- Test: `hooks/claude-remote-session-id.test.ts` (append)

**Interfaces:**

- Consumes: `deriveClaudePid`, `startTimeOf` (Task 1).
- Produces:
  - `interface RegistryRecord { launchUuid: string; claudePid: number; startTime: string; sessionId: string; cwd: string; source: string; updatedAt: string }`
  - `mintDecision(existing: RegistryRecord[], claudePid: number, startTime: string, sessionId: string, cwd: string, source: string, now: string, newUuid: string): { record: RegistryRecord; isNew: boolean }` — pure. If `existing` has a record with the same `claudePid`+`startTime`, return it with `sessionId`/`updatedAt` refreshed (`isNew:false`). Else build a new record with `launchUuid = newUuid` (`isNew:true`).
  - IO `writeRegistryRecord(rec)` → writes `${STATE_DIR}/registry/<launchUuid>.json` (mkdir -p first), and `readRegistryDirSync()` → `RegistryRecord[]`.

- [ ] **Step 1: Write the failing test**

```ts
import { mintDecision, type RegistryRecord } from "./claude-remote-session-id";

const base = (o: Partial<RegistryRecord>): RegistryRecord => ({
  launchUuid: "u1",
  claudePid: 100,
  startTime: "T",
  sessionId: "s1",
  cwd: "/a",
  source: "startup",
  updatedAt: "t0",
  ...o,
});

test("mintDecision mints a NEW record when no pid+startTime match", () => {
  const d = mintDecision([], 100, "T", "s1", "/a", "startup", "t1", "NEW-UUID");
  expect(d.isNew).toBe(true);
  expect(d.record.launchUuid).toBe("NEW-UUID");
  expect(d.record.sessionId).toBe("s1");
});

test("mintDecision REUSES the launchUuid and re-anchors sessionId on a later fire", () => {
  const existing = [
    base({ launchUuid: "u1", claudePid: 100, startTime: "T", sessionId: "s1" }),
  ];
  const d = mintDecision(
    existing,
    100,
    "T",
    "s2-rolled",
    "/a",
    "clear",
    "t2",
    "IGNORED-UUID",
  );
  expect(d.isNew).toBe(false);
  expect(d.record.launchUuid).toBe("u1"); // stable
  expect(d.record.sessionId).toBe("s2-rolled"); // re-anchored
  expect(d.record.updatedAt).toBe("t2");
});

test("mintDecision treats same pid but different startTime as a NEW session (pid reuse)", () => {
  const existing = [base({ claudePid: 100, startTime: "T-old" })];
  const d = mintDecision(
    existing,
    100,
    "T-new",
    "s9",
    "/a",
    "startup",
    "t3",
    "NEW2",
  );
  expect(d.isNew).toBe(true);
  expect(d.record.launchUuid).toBe("NEW2");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test hooks/claude-remote-session-id.test.ts`
Expected: FAIL — `mintDecision`/`RegistryRecord` not exported.

- [ ] **Step 3: Implement**

```ts
export interface RegistryRecord {
  launchUuid: string;
  claudePid: number;
  startTime: string;
  sessionId: string;
  cwd: string;
  source: string;
  updatedAt: string;
}

export function mintDecision(
  existing: RegistryRecord[],
  claudePid: number,
  startTime: string,
  sessionId: string,
  cwd: string,
  source: string,
  now: string,
  newUuid: string,
): { record: RegistryRecord; isNew: boolean } {
  const hit = existing.find(
    (r) => r.claudePid === claudePid && r.startTime === startTime,
  );
  if (hit) {
    return {
      record: { ...hit, sessionId, source, updatedAt: now },
      isNew: false,
    };
  }
  return {
    record: {
      launchUuid: newUuid,
      claudePid,
      startTime,
      sessionId,
      cwd,
      source,
      updatedAt: now,
    },
    isNew: true,
  };
}
```

IO (near the other fs helpers; `REGISTRY_DIR = join(STATE_DIR, "registry")`):

```ts
function readRegistryDirSync(): RegistryRecord[] {
  try {
    return readdirSync(REGISTRY_DIR)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          return [
            JSON.parse(
              readFileSync(join(REGISTRY_DIR, f), "utf-8"),
            ) as RegistryRecord,
          ];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
function writeRegistryRecord(rec: RegistryRecord): void {
  mkdirSync(REGISTRY_DIR, { recursive: true });
  writeFileSync(
    join(REGISTRY_DIR, `${rec.launchUuid}.json`),
    JSON.stringify(rec, null, 2),
  );
}
```

(Add `mkdirSync` to the `fs` import; `REGISTRY_DIR` next to `STATE_DIR`.)

- [ ] **Step 4: Run to verify it passes**

Run: `bun test hooks/claude-remote-session-id.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hooks/claude-remote-session-id.ts hooks/claude-remote-session-id.test.ts
git commit -m "feat(identity-p2): mintDecision (pure) + registry read/write IO in the hook"
```

---

### Task 3: Wire the mint into the hook's `main()` (additive)

**Files:**

- Modify: `hooks/claude-remote-session-id.ts` (`main()` — hoist `ppidMap`/`ancestry`, then mint BEFORE the port-file bails so it is race-free)
- Test: manual smoke (the pure pieces are covered in Tasks 1–2; this is IO glue)

**Interfaces:**

- Consumes: `deriveClaudePid`, `startTimeOf`, `mintDecision`, `readRegistryDirSync`, `writeRegistryRecord` (Tasks 1–2) + the existing `ancestry`, `sessionId`, `cwd`, `input.source`.

**RACE-FREE requirement:** the mint MUST run at SessionStart even when the relay port file does not exist yet (the spawn race). `buildPpidMap()` (`ps -eo`) and `deriveClaudePid`'s "closest `claude`-comm ancestor" fallback are port-file-INDEPENDENT, so the mint is derived from the process tree — NOT from `target`. Do NOT gate the mint on a port file.

- [ ] **Step 1a: Hoist `ppidMap` + `ancestry` above the `bail_no_port_files` return**

In `main()`, MOVE these two lines:

```ts
const ppidMap = buildPpidMap();
const ancestry = ancestryChain(process.pid, (pid) => ppidMap.get(pid));
```

from their current position (just above `const target = selectPortFile(candidates, cwd!, ancestry);`) to immediately AFTER the `bail_bad_stdin`/`bail_missing_fields` early-return block and BEFORE `const candidates = readPortFiles(stateDir());`. The `selectPortFile` call below now reads the hoisted `ancestry` (do not re-declare it).

- [ ] **Step 1b: Add the race-free mint immediately after the hoisted `ancestry` line**

(Before `const candidates = readPortFiles(...)`; wrapped so it can never break session start.)

```ts
// --- P2: mint/refresh the stable launchUuid — race-free (derived from the
// process tree, works even before the relay writes its port file) ---
try {
  if (sessionId && cwd) {
    const commOf = (pid: number): string | undefined => {
      try {
        return execSync(`ps -o comm= -p ${pid}`, {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        })
          .trim()
          .split("/")
          .pop();
      } catch {
        return undefined;
      }
    };
    const claudePid = deriveClaudePid(ancestry, commOf, undefined);
    if (claudePid !== undefined) {
      const startTime = startTimeOf(claudePid);
      if (startTime) {
        const { record } = mintDecision(
          readRegistryDirSync(),
          claudePid,
          startTime,
          sessionId,
          cwd,
          input.source ?? "unknown",
          new Date().toISOString(),
          crypto.randomUUID(),
        );
        writeRegistryRecord(record);
      }
    }
  }
} catch (err) {
  logLine(`registry mint failed: ${err}`);
}
```

Notes: `deriveClaudePid(ancestry, commOf, undefined)` uses the comm-ancestor fallback (no `target`/port file needed) — this is what makes the mint race-free. `crypto.randomUUID()` is a Bun global. `logLine` is the file's existing log helper. `input.source` (NOT `source` — the var is `input.source`). Everything below (`candidates`/`target`/write) is UNCHANGED.

- [ ] **Step 2: Verify the pure suite still passes + typecheck**

Run: `bun test hooks/claude-remote-session-id.test.ts && bun run typecheck`
Expected: PASS + clean.

- [ ] **Step 3: Live smoke — mint a real record**

Run (simulates a SessionStart fire against your own shell as a stand-in is unreliable; instead run the hook end-to-end):

```bash
CLAUDE_TELEGRAM_STATE_DIR=/tmp/p2reg bash -c '
  mkdir -p /tmp/p2reg/registry
  echo "{\"session_id\":\"smoke-sid\",\"cwd\":\"$PWD\",\"source\":\"startup\"}" | bun hooks/claude-remote-session-id.ts
  echo "--- registry files ---"; ls /tmp/p2reg/registry/ 2>/dev/null; cat /tmp/p2reg/registry/*.json 2>/dev/null'
```

Expected: a `<uuid>.json` with `claudePid`, `startTime`, `sessionId:"smoke-sid"`. (If `claudePid` couldn't be derived in this synthetic run, that's acceptable — the block no-ops; the real path is exercised by a running Claude session in the soak.) Clean up: `rm -rf /tmp/p2reg`.

- [ ] **Step 4: Commit**

```bash
git add hooks/claude-remote-session-id.ts
git commit -m "feat(identity-p2): wire launchUuid mint into the SessionStart hook (additive)"
```

---

### Task 4: Bot-side registry reader

**Files:**

- Create: `src/sessions/registry.ts`
- Test: `src/__tests__/registry.test.ts`

**Interfaces:**

- Produces:
  - `interface RegistryRecord { launchUuid; claudePid; startTime; sessionId; cwd; source; updatedAt }` (mirror the hook's — duplicated by design; the hook can't export to `src/`).
  - `readRegistry(readDir = defaultReadDir): RegistryRecord[]` — reads `${STATE_DIR}/registry/*.json`; skips unparseable; `[]` if the dir is absent.
  - `launchUuidByClaudePid(records: RegistryRecord[]): Map<number, string>` — pure index (claudePid → launchUuid); on duplicate claudePid keeps the record with the latest `updatedAt`.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import {
  launchUuidByClaudePid,
  type RegistryRecord,
} from "../sessions/registry";

const r = (o: Partial<RegistryRecord>): RegistryRecord => ({
  launchUuid: "u",
  claudePid: 1,
  startTime: "T",
  sessionId: "s",
  cwd: "/a",
  source: "startup",
  updatedAt: "2026-01-01T00:00:00Z",
  ...o,
});

test("launchUuidByClaudePid indexes pid → launchUuid", () => {
  const m = launchUuidByClaudePid([r({ claudePid: 100, launchUuid: "A" })]);
  expect(m.get(100)).toBe("A");
});

test("on duplicate claudePid, keeps the latest updatedAt", () => {
  const m = launchUuidByClaudePid([
    r({ claudePid: 100, launchUuid: "OLD", updatedAt: "2026-01-01T00:00:00Z" }),
    r({ claudePid: 100, launchUuid: "NEW", updatedAt: "2026-06-01T00:00:00Z" }),
  ]);
  expect(m.get(100)).toBe("NEW");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/__tests__/registry.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/sessions/registry.ts` (import `STATE_DIR` from `../paths` — confirm the export name in `src/paths.ts`):

```ts
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { STATE_DIR } from "../paths";

export interface RegistryRecord {
  launchUuid: string;
  claudePid: number;
  startTime: string;
  sessionId: string;
  cwd: string;
  source: string;
  updatedAt: string;
}

const REGISTRY_DIR = join(STATE_DIR, "registry");

function defaultReadDir(): RegistryRecord[] {
  try {
    return readdirSync(REGISTRY_DIR)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          return [
            JSON.parse(
              readFileSync(join(REGISTRY_DIR, f), "utf-8"),
            ) as RegistryRecord,
          ];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function readRegistry(
  readDir: () => RegistryRecord[] = defaultReadDir,
): RegistryRecord[] {
  return readDir();
}

export function launchUuidByClaudePid(
  records: RegistryRecord[],
): Map<number, string> {
  const latest = new Map<number, RegistryRecord>();
  for (const rec of records) {
    const cur = latest.get(rec.claudePid);
    if (!cur || rec.updatedAt > cur.updatedAt) latest.set(rec.claudePid, rec);
  }
  return new Map([...latest].map(([pid, rec]) => [pid, rec.launchUuid]));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/__tests__/registry.test.ts && bun run typecheck`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/registry.ts src/__tests__/registry.test.ts
git commit -m "feat(identity-p2): bot-side registry reader + launchUuid index"
```

---

### Task 5: `resolveSession` launchUuid path + shadow wiring (observe-only)

**Files:**

- Modify: `src/sessions/resolve-session.ts` (add `launchUuid` to `SessionRecord`; populate `by:"launchId"`)
- Modify: `src/sessions/watcher.ts` (attach `launchUuid` to snapshot records; call the shadow)
- Modify: `src/sessions/identity-shadow.ts` (add `shadowLaunchUuid`)
- Test: `src/sessions/resolve-session.test.ts`, `src/__tests__/identity-shadow.test.ts`

**Interfaces:**

- Consumes: `launchUuidByClaudePid`, `readRegistry` (Task 4); the existing snapshot build in `watcher.ts`.
- Produces: `SessionRecord.launchUuid: string | null`; `resolveSession({by:"launchId", launchId})` resolves the record whose `launchUuid === launchId`; `shadowLaunchUuid(records, snap)` logs a divergence where resolving `by:launchId` disagrees with the record's own identity.

- [ ] **Step 1: Write the failing test (resolver)**

Append to `src/sessions/resolve-session.test.ts`:

```ts
test("resolveSession by launchId returns the record with that launchUuid", () => {
  const snap = {
    aliveRelays: [
      {
        port: 1,
        pid: 10,
        ppid: 100,
        cwd: "/a",
        startedAt: "t",
        sessionId: "sX",
      } as any,
    ],
    topics: [],
  };
  // populate launchUuid on the built record via the new snapshot field
  const s = { ...snap, launchUuidByPid: new Map([[100, "L-1"]]) } as any;
  const r = resolveSession({ by: "launchId", launchId: "L-1" }, s);
  expect(r.status).toBe("resolved");
  if (r.status === "resolved") expect(r.record.launchUuid).toBe("L-1");
});

test("resolveSession by launchId misses when no record carries it", () => {
  const snap = { aliveRelays: [], topics: [] } as any;
  expect(
    resolveSession({ by: "launchId", launchId: "nope" }, snap).status,
  ).toBe("miss");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/sessions/resolve-session.test.ts`
Expected: FAIL — launchId still returns miss / `launchUuidByPid` unused.

- [ ] **Step 3: Implement**

In `resolve-session.ts`: add `launchUuid: string | null` to `SessionRecord` and `makeRecord`; add optional `launchUuidByPid?: Map<number, string>` to `ResolveSnapshot`; in `buildRecords`, set `launchUuid: snap.launchUuidByPid?.get(ri.claudePid) ?? null`; replace the `case "launchId": return { status: "miss" }` with `return pick((r) => r.launchUuid === handle.launchId)`.

In `watcher.ts` refresh, where `setCurrentSnapshot` is called (line ~303), build the map and include it:

```ts
import { readRegistry, launchUuidByClaudePid } from "./registry";
import { shadowLaunchUuid } from "./identity-shadow";
// ...
const launchUuidByPid = launchUuidByClaudePid(readRegistry());
setCurrentSnapshot({
  aliveRelays: portFiles,
  topics: [...getTopicStore().topics],
  launchUuidByPid,
});
shadowLaunchUuid(getCurrentSnapshot()); // observe-only
```

In `identity-shadow.ts`, add:

```ts
import {
  resolveSession,
  getCurrentSnapshot,
  type ResolveSnapshot,
} from "./resolve-session";
export function shadowLaunchUuid(snap: ResolveSnapshot): void {
  try {
    for (const [pid, uuid] of snap.launchUuidByPid ?? []) {
      const byLaunch = resolveSession({ by: "launchId", launchId: uuid }, snap);
      const byPid = resolveSession({ by: "pid", pid }, snap);
      const a =
        byLaunch.status === "resolved"
          ? byLaunch.record.sessionId
          : byLaunch.status;
      const b =
        byPid.status === "resolved" ? byPid.record.sessionId : byPid.status;
      if (a !== b)
        info("identity-shadow: launchUuid divergence", {
          pid,
          uuid,
          byLaunch: String(a),
          byPid: String(b),
        });
    }
  } catch {
    /* observe-only */
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/sessions/resolve-session.test.ts src/__tests__/identity-shadow.test.ts && bun run typecheck`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/resolve-session.ts src/sessions/watcher.ts src/sessions/identity-shadow.ts src/sessions/resolve-session.test.ts src/__tests__/identity-shadow.test.ts
git commit -m "feat(identity-p2): resolveSession launchUuid path + observe-only launchUuid shadow"
```

- [ ] **Step 6: SOAK GATE (manual, after deploy)**

Restart the bot (`./restart.sh`), run a couple of `ccd` sessions (they run the hook → mint registry records), `/clear` one, and confirm in `~/Library/Logs/claude-mobile-bridge/bot.log`:

- registry files appear under `~/.claude-mobile-bridge/registry/`,
- `identity-shadow: launchUuid divergence` count stays **0** (the launchUuid resolution matches the pid resolution),
- no errors. Zero divergence over a soak = the registry is trustworthy → P3a can start migrating consumers onto `by:launchId`.

---

## Self-Review

1. **Spec coverage:** §2 core (hook mints launchUuid keyed pid+startTime → Tasks 1–3; registry → Tasks 2,4; resolveSession launchUuid path → Task 5). §6 P2 "writer side, observe-only, nothing deleted" → every task is additive; the shadow is observe-only. Carve-outs/fail-loud/topic/launcher are P3 (not this plan). ✅
2. **Placeholder scan:** the hook's log-helper name and `src/paths.ts` `STATE_DIR` export name are flagged as "confirm the exact name" — the implementer verifies against the file; not a TBD in logic. `crypto.randomUUID()`, `mkdirSync` import noted. No "handle edge cases"/"add validation" placeholders. ✅
3. **Type consistency:** `RegistryRecord` fields identical in hook (Task 2) and `src/sessions/registry.ts` (Task 4); `launchUuid`, `claudePid`, `startTime`, `updatedAt` used consistently; `Handle` `by:"launchId"` (existing) matches the resolver change. `SessionRecord.launchUuid` added in Task 5 and used by the shadow. ✅

## Execution Handoff

This is P2 of three (P3a migrate consumers, P3b delete+flip follow, per the spec). It's purely additive/observe-only and ends on a soak gate that must read clean before P3a.
