/**
 * S5 — Startup backfill turns an unroutable port file into a routable one.
 *
 * Sequence:
 *   1. Relay process wrote its port file WITHOUT sessionId (the bug that
 *      yesterday's discovery-loop-race fix addressed for new relays; older
 *      ones may still have file in this state).
 *   2. Bot starts → backfillPortFileSessionIds runs.
 *   3. Selector by sessionId now finds the relay.
 *
 * Locks down the rescue path. Unit tests already cover backfill internals;
 * this is the end-to-end view.
 */

import {
  setupIsolatedStateDir,
  teardownStateDir,
  writePortFile,
  writeFakeJsonl,
  cleanupProjectDir,
} from "./_helpers";

const STATE_DIR = setupIsolatedStateDir();

import { describe, expect, test, afterAll } from "bun:test";
const { backfillPortFileSessionIds } = await import("../../relay/backfill");
const { invalidateScanCache } = await import("../../relay");
const { setIsRelayProcessProbe, scanPortFiles, selectRelayTarget } =
  await import("../../relay/discovery");

setIsRelayProcessProbe(() => true);

const CWD = "/tmp/__phase0_s5__";
const SID = "55555555-5555-5555-5555-555555555555";

afterAll(() => {
  setIsRelayProcessProbe(null);
  teardownStateDir(STATE_DIR);
  cleanupProjectDir(CWD);
});

describe("S5 — backfill end-to-end", () => {
  test("port file without sessionId is unroutable, then routable after backfill", async () => {
    writeFakeJsonl(CWD, SID);
    writePortFile(STATE_DIR, {
      pid: process.pid, // real pid so isProcessAlive passes in backfill
      port: 60099,
      cwd: CWD,
      // no sessionId
    });
    invalidateScanCache();

    // Before: lookup by sessionId fails.
    const aliveBefore = await scanPortFiles(true);
    const beforePick = selectRelayTarget(aliveBefore, { sessionId: SID });
    expect(beforePick).toBeNull();

    // Run the backfill (production calls this once at bot startup).
    await backfillPortFileSessionIds();
    invalidateScanCache();

    // After: same lookup succeeds.
    const aliveAfter = await scanPortFiles(true);
    const afterPick = selectRelayTarget(aliveAfter, { sessionId: SID });
    expect(afterPick).not.toBeNull();
    expect(afterPick!.sessionId).toBe(SID);
    expect(afterPick!.cwd).toBe(CWD);
  });
});
