/**
 * The bot must stop serving a cached relay client once that relay's claude dies.
 *
 * This is the half of the orphan bug that the scan-level filter does NOT cover:
 * `getRelayClient` returns a cached client before it ever scans, gated only on
 * `isConnected`. An orphaned relay keeps its TCP server listening, so the
 * socket never goes stale and the cached client looks healthy forever while
 * every message it carries is swallowed. In the reported incident the bot had
 * already cached a client for the session before its claude died, so filtering
 * the scan alone would have left the session just as broken.
 */

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { createServer, type Server } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, expect, test } from "bun:test";

const STATE_DIR = mkdtempSync(join(tmpdir(), "orphan-cache-"));
process.env.CLAUDE_TELEGRAM_STATE_DIR = STATE_DIR;

// Dynamic import AFTER the env var: paths.ts caches STATE_DIR at module load.
const {
  getRelayClient,
  invalidateScanCache,
  setIsRelayProcessProbe,
  setParentAliveProbe,
} = await import("./discovery");

setIsRelayProcessProbe(() => true);

const CWD = "/tmp/__orphan_cache__";
const SID = "cccccccc-1111-2222-3333-444444444444";
const CLAUDE_PID = 424242;

// Two stand-in relays, both listening for real so `isConnected` stays true —
// the point being that liveness of the socket says nothing about the claude
// behind it.
let servers: Server[] = [];

function listen(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(() => {});
    servers.push(s);
    s.listen(0, "127.0.0.1", () =>
      resolve((s.address() as { port: number }).port),
    );
  });
}

function writePortFile(name: string, port: number, ppid: number): void {
  writeFileSync(
    join(STATE_DIR, name),
    JSON.stringify({
      port,
      pid: process.pid,
      ppid,
      sessionId: SID,
      cwd: CWD,
      startedAt: "2026-08-03T14:20:22.065Z",
    }),
  );
}

afterAll(() => {
  setIsRelayProcessProbe(null);
  setParentAliveProbe(null);
  for (const s of servers) s.close();
  rmSync(STATE_DIR, { recursive: true, force: true });
});

test("a cached client is dropped once its claude dies, and re-resolves to the live relay", async () => {
  const firstPort = await listen();
  writePortFile("channel-relay-first-1.json", firstPort, CLAUDE_PID);
  setParentAliveProbe(() => true); // claude alive
  invalidateScanCache();

  const first = await getRelayClient({ sessionId: SID });
  expect(first).not.toBeNull();
  expect(first!.isConnected).toBe(true);

  // Cached, claude still alive → same instance, no rescan.
  expect(await getRelayClient({ sessionId: SID })).toBe(first!);

  // Claude dies. Its relay keeps listening, so `isConnected` stays true — the
  // session restarts and a second relay takes over the same sessionId.
  const secondPort = await listen();
  writePortFile("channel-relay-second-2.json", secondPort, process.pid);
  setParentAliveProbe((pid) => pid !== CLAUDE_PID);
  invalidateScanCache();

  // The orphan's socket is still up, so `isConnected` alone would have handed
  // the dead session's client straight back.
  expect(first!.isConnected).toBe(true);

  const second = await getRelayClient({ sessionId: SID });

  expect(second).not.toBeNull();
  expect(second).not.toBe(first!); // …but we no longer hand it out
  expect(first!.isConnected).toBe(false); // and the stale one is torn down
});
