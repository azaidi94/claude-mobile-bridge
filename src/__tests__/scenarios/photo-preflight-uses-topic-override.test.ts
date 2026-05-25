/**
 * S2 — Photo handler's relay preflight uses the topic-bound session, not the
 * globally-most-recent one.
 *
 * This locks down the regression we shipped 2026-05-25: photo/voice/document
 * handlers used `getActiveSession()` for the relay preflight, which gets
 * hijacked by Cursor's CDP nudges. The right behaviour is to prefer the
 * topic-resolved sessionOverride.
 *
 * We test the selector layer (`selectRelayTarget`) rather than the full
 * TCP-connect `isRelayAvailable`, because:
 *   - the routing logic that the bug lived in IS the selector layer
 *   - testing TCP connect adds infra friction without buying extra coverage
 */

import {
  setupIsolatedStateDir,
  teardownStateDir,
  writePortFile,
  writeFakeJsonl,
  cleanupProjectDir,
} from "./_helpers";

const STATE_DIR = setupIsolatedStateDir();

import { describe, expect, test, beforeEach, afterAll } from "bun:test";
const { invalidateScanCache } = await import("../../relay");
const { setIsRelayProcessProbe, scanPortFiles, selectRelayTarget } =
  await import("../../relay/discovery");

setIsRelayProcessProbe(() => true);

const CC_CWD_A = "/tmp/__phase0_s2_cc_a__";
const CC_ID_A = "aaaaaaaa-1111-2222-3333-444444444444";
const CC_PID_A = 50001;

const CC_CWD_B = "/tmp/__phase0_s2_cc_b__";
const CC_ID_B = "bbbbbbbb-1111-2222-3333-444444444444";
const CC_PID_B = 50002;

beforeEach(() => {
  writeFakeJsonl(CC_CWD_A, CC_ID_A);
  writeFakeJsonl(CC_CWD_B, CC_ID_B);
  writePortFile(STATE_DIR, {
    pid: CC_PID_A,
    port: 60001,
    cwd: CC_CWD_A,
    sessionId: CC_ID_A,
  });
  writePortFile(STATE_DIR, {
    pid: CC_PID_B,
    port: 60002,
    cwd: CC_CWD_B,
    sessionId: CC_ID_B,
  });
  invalidateScanCache();
});

afterAll(() => {
  setIsRelayProcessProbe(null);
  teardownStateDir(STATE_DIR);
  cleanupProjectDir(CC_CWD_A);
  cleanupProjectDir(CC_CWD_B);
});

describe("S2 — preflight prefers topic-bound session", () => {
  test("selector by sessionId picks the right relay even when another is active", async () => {
    const alive = await scanPortFiles(true);
    const picked = selectRelayTarget(alive, { sessionId: CC_ID_A });
    expect(picked).not.toBeNull();
    expect(picked!.sessionId).toBe(CC_ID_A);
    expect(picked!.cwd).toBe(CC_CWD_A);
  });

  test("selector by sessionDir picks the right relay when dir is unique", async () => {
    const alive = await scanPortFiles(true);
    const picked = selectRelayTarget(alive, { sessionDir: CC_CWD_B });
    expect(picked).not.toBeNull();
    expect(picked!.sessionId).toBe(CC_ID_B);
  });

  test("WRONG sessionId returns null (no fallback to dir match)", async () => {
    const alive = await scanPortFiles(true);
    const picked = selectRelayTarget(alive, {
      sessionId: "deadbeef-0000-0000-0000-000000000000",
    });
    expect(picked).toBeNull();
  });

  test("Cursor synthetic sessionId never matches a CC relay", async () => {
    const alive = await scanPortFiles(true);
    const picked = selectRelayTarget(alive, { sessionId: "cursor-foo" });
    expect(picked).toBeNull();
  });

  test("sessionId AND sessionDir together — sessionId wins on mismatch", async () => {
    // The exact bug-condition we shipped against: a Cursor sessionOverride
    // landing in a CC selector with both fields populated. If selectRelayTarget
    // ever silently falls back to dir-match when sessionId is set but unknown,
    // it would resurrect the cross-session routing bug.
    const alive = await scanPortFiles(true);
    const picked = selectRelayTarget(alive, {
      sessionId: "deadbeef-0000-0000-0000-000000000000",
      sessionDir: CC_CWD_A,
    });
    expect(picked).toBeNull();
  });
});
