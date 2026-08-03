/**
 * A relay whose parent Claude has died must not be routable.
 *
 * Regression: a Cursor-hosted session was restarted; the old relay survived its
 * claude (reparented to launchd) and kept a port file carrying the SAME
 * sessionId as the new one. The bot connected to the orphan and every message
 * it forwarded disappeared into a session that no longer existed. Two things
 * had to hold to fix it — the scan must drop the orphan, AND an already-cached
 * client must not keep serving it (its TCP server is still listening, so the
 * socket alone never goes stale).
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeEach, expect, test } from "bun:test";

const STATE_DIR = mkdtempSync(join(tmpdir(), "orphan-scan-"));
process.env.CLAUDE_TELEGRAM_STATE_DIR = STATE_DIR;

// Dynamic import AFTER the env var: paths.ts caches STATE_DIR at module load.
const { scanPortFiles, setIsRelayProcessProbe } = await import("./discovery");

// Both port files below name this process as their relay pid; the probe
// override skips the `ps … | includes("channel-relay")` check so they count as
// live relays. Parent liveness — the thing under test — is NOT stubbed.
setIsRelayProcessProbe(() => true);

afterAll(() => {
  setIsRelayProcessProbe(null);
  rmSync(STATE_DIR, { recursive: true, force: true });
});

const DEAD_PPID = 0x7fffffff; // above every platform's pid_max
const CWD = "/tmp/__orphan_scan__";
const SID = "01b8b096-d5ef-4293-9976-60d6bc68139f";

const ORPHAN = "channel-relay-orphan-1.json";
const LIVE = "channel-relay-live-2.json";

function write(name: string, data: Record<string, unknown>): void {
  writeFileSync(join(STATE_DIR, name), JSON.stringify(data, null, 2));
}

beforeEach(() => {
  for (const f of readdirSync(STATE_DIR)) {
    rmSync(join(STATE_DIR, f), { force: true });
  }
});

test("scanPortFiles drops the orphan and keeps the live sibling sharing its sessionId", async () => {
  write(ORPHAN, {
    port: 63785,
    pid: process.pid,
    ppid: DEAD_PPID,
    sessionId: SID,
    cwd: CWD,
    startedAt: "2026-08-03T14:20:22.065Z",
  });
  write(LIVE, {
    port: 64104,
    pid: process.pid,
    ppid: process.pid, // alive
    sessionId: SID,
    cwd: CWD,
    startedAt: "2026-08-03T14:21:20.093Z",
  });

  const alive = await scanPortFiles(true);

  expect(alive.map((p) => p.port)).toEqual([64104]);
});

test("the orphan's port file is skipped, not unlinked — its relay still owns it", async () => {
  write(ORPHAN, {
    port: 63785,
    pid: process.pid,
    ppid: DEAD_PPID,
    sessionId: SID,
    cwd: CWD,
    startedAt: "2026-08-03T14:20:22.065Z",
  });

  await scanPortFiles(true);

  expect(existsSync(join(STATE_DIR, ORPHAN))).toBe(true);
});
