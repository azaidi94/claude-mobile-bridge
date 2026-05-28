process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "1";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  SessionState,
  getSessionState,
  dropSessionState,
  listSessionStates,
  setOnSessionStateCreated,
  _resetSessionStatesForTests,
} from "../sessions/session-state";
import type { SessionInfo } from "../sessions/types";
import type { PlanApprovalState } from "../types";

describe("SessionState resolver", () => {
  beforeEach(() => {
    _resetSessionStatesForTests();
  });

  test("getSessionState returns the same instance on repeated calls", () => {
    const a1 = getSessionState("alpha");
    const a2 = getSessionState("alpha");
    expect(a1).toBe(a2);
    expect(a1).toBeInstanceOf(SessionState);
    expect(a1.sessionName).toBe("alpha");
  });

  test("distinct names yield distinct instances", () => {
    const a = getSessionState("alpha");
    const b = getSessionState("beta");
    expect(a).not.toBe(b);
    expect(a.sessionName).toBe("alpha");
    expect(b.sessionName).toBe("beta");
  });

  test("dropSessionState removes the entry; next lookup returns a new instance", () => {
    const before = getSessionState("alpha");
    before.lastMessage = "hello";
    dropSessionState("alpha");
    const after = getSessionState("alpha");
    expect(after).not.toBe(before);
    expect(after.lastMessage).toBeNull();
  });

  test("listSessionStates returns all live instances", () => {
    getSessionState("alpha");
    getSessionState("beta");
    const all = listSessionStates();
    expect(all.length).toBe(2);
    const names = all.map((s) => s.sessionName).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });
});

describe("SessionState helper methods", () => {
  beforeEach(() => {
    _resetSessionStatesForTests();
  });

  test("interrupt flag round-trip: markInterrupt + consumeInterruptFlag", () => {
    const s = getSessionState("alpha");
    expect(s.consumeInterruptFlag()).toBe(false);
    s.markInterrupt();
    s.stopRequested = true;
    expect(s.consumeInterruptFlag()).toBe(true);
    // consume clears the flag and stopRequested
    expect(s.stopRequested).toBe(false);
    // second consume returns false (already cleared)
    expect(s.consumeInterruptFlag()).toBe(false);
  });

  test("clearStopRequested clears the flag", () => {
    const s = getSessionState("alpha");
    s.stopRequested = true;
    s.clearStopRequested();
    expect(s.stopRequested).toBe(false);
  });

  test("pendingPlanApproval set/clear round-trip", () => {
    const s = getSessionState("alpha");
    expect(s.pendingPlanApproval).toBeNull();
    const plan: PlanApprovalState = {
      toolUseId: "tu_1",
      planSummary: "summary",
      planContent: "content",
      timestamp: 12345,
    };
    s.pendingPlanApproval = plan;
    expect(s.pendingPlanApproval).toEqual(plan);
    s.clearPendingPlanApproval();
    expect(s.pendingPlanApproval).toBeNull();
  });

  test("startProcessing toggles _isProcessing via returned cleanup", () => {
    const s = getSessionState("alpha");
    expect(s._isProcessing).toBe(false);
    const done = s.startProcessing();
    expect(s._isProcessing).toBe(true);
    expect(s.isRunning).toBe(true);
    done();
    expect(s._isProcessing).toBe(false);
    expect(s.isRunning).toBe(false);
  });

  test("isActive reflects sessionId", () => {
    const s = getSessionState("alpha");
    expect(s.isActive).toBe(false);
    s.sessionId = "uuid-1";
    expect(s.isActive).toBe(true);
    s.clearSession();
    expect(s.isActive).toBe(false);
    expect(s.lastActivity).toBeNull();
  });

  test("loadFromRegistry populates fields from SessionInfo", () => {
    const s = getSessionState("alpha");
    const info: SessionInfo = {
      id: "uuid-abc",
      name: "alpha",
      dir: "/tmp/work",
      lastActivity: 1_700_000_000_000,
      source: "telegram",
      pid: 4321,
    };
    s.loadFromRegistry(info);
    expect(s.sessionId).toBe("uuid-abc");
    expect(s.sessionName).toBe("alpha");
    expect(s.workingDir).toBe("/tmp/work");
    expect(s.lastActivity).toBeInstanceOf(Date);
    expect(s.lastActivity?.getTime()).toBe(1_700_000_000_000);
  });

  test("loadFromRegistry with empty id leaves sessionId null", () => {
    const s = getSessionState("alpha");
    const info: SessionInfo = {
      id: "",
      name: "alpha",
      dir: "/tmp/work",
      lastActivity: 0,
      source: "desktop",
    };
    s.loadFromRegistry(info);
    expect(s.sessionId).toBeNull();
  });

  test("setWorkingDir updates workingDir", () => {
    const s = getSessionState("alpha");
    s.setWorkingDir("/some/path");
    expect(s.workingDir).toBe("/some/path");
  });
});

describe("SessionState cleanups (listener-leak guard)", () => {
  beforeEach(() => {
    _resetSessionStatesForTests();
  });
  afterEach(() => {
    setOnSessionStateCreated(null);
    _resetSessionStatesForTests();
  });

  test("dropSessionState runs registered cleanups once", () => {
    const s = getSessionState("alpha");
    let runs = 0;
    s.registerCleanup(() => runs++);
    dropSessionState("alpha");
    expect(runs).toBe(1);
    // Dropping again must not re-run a cleared cleanup.
    dropSessionState("alpha");
    expect(runs).toBe(1);
  });

  test("a misbehaving cleanup does not block the drop", () => {
    const s = getSessionState("alpha");
    let secondRan = false;
    s.registerCleanup(() => {
      throw new Error("boom");
    });
    s.registerCleanup(() => {
      secondRan = true;
    });
    expect(() => dropSessionState("alpha")).not.toThrow();
    expect(secondRan).toBe(true);
  });

  test("kill→recreate does not stack create-hook subscriptions", () => {
    // Mirrors index.ts: the create hook attaches a per-session listener and
    // registers its teardown. Each drop must detach it so a recreate of the
    // same name yields exactly one live listener, not N.
    let liveListeners = 0;
    setOnSessionStateCreated((state) => {
      liveListeners++;
      state.registerCleanup(() => liveListeners--);
    });

    getSessionState("alpha");
    expect(liveListeners).toBe(1);

    for (let i = 0; i < 5; i++) {
      dropSessionState("alpha");
      getSessionState("alpha");
    }
    // Without the cleanup wiring this would be 6 (one stacked per recreate).
    expect(liveListeners).toBe(1);
  });
});
