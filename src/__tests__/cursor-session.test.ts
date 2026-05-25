import { describe, it, expect, beforeEach } from "bun:test";
import {
  addCursorSession,
  getSession,
  removeSession,
  getSessions,
} from "../sessions";

describe("addCursorSession", () => {
  const name = "cursor-test-session";

  beforeEach(() => {
    removeSession(name);
  });

  it("registers a session with source cursor", () => {
    addCursorSession({ name, dir: "/tmp/proj" });
    const s = getSession(name);
    expect(s).not.toBeNull();
    expect(s!.source).toBe("cursor");
    expect(s!.name).toBe(name);
    expect(s!.dir).toBe("/tmp/proj");
  });

  it("does NOT bump lastActivity on re-registration (task 8)", async () => {
    // Re-registration is the cursor-bridge attach/reconnect path; treating
    // it as activity makes cursor sessions falsely look "most-recently
    // active" and hijacks dir-match heuristics in sendViaRelay.
    addCursorSession({ name, dir: "/tmp/proj" });
    const first = getSession(name)!.lastActivity;
    await new Promise((r) => setTimeout(r, 5));
    addCursorSession({ name, dir: "/tmp/proj" });
    const second = getSession(name)!.lastActivity;
    expect(second).toBe(first);
    // Still idempotent — no duplicate
    const all = getSessions();
    expect(all.filter((s) => s.name === name).length).toBe(1);
  });

  it("fires onChangeCallback once on first registration, not on re-registration", () => {
    addCursorSession({ name, dir: "/tmp/proj" });
    // After calling once, the session should exist
    const allAfterFirst = getSessions();
    expect(allAfterFirst.filter((s) => s.name === name).length).toBe(1);
    expect(getSession(name)!.source).toBe("cursor");

    // After calling again with the same name, there should still be only 1
    addCursorSession({ name, dir: "/tmp/proj" });
    const allAfterSecond = getSessions();
    expect(allAfterSecond.filter((s) => s.name === name).length).toBe(1);

    // The session source should remain cursor
    expect(getSession(name)!.source).toBe("cursor");
  });
});
