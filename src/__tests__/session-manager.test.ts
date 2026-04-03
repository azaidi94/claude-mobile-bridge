/**
 * Unit tests for SessionManager (sessions/watcher.ts).
 *
 * Tests session discovery, tracking, and lifecycle management.
 * Note: Tests run against the real module with persistent state,
 * so we use unique names and relative assertions.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  startWatcher,
  stopWatcher,
  forceRefresh,
  getSessions,
  getActiveSession,
  setActiveSession,
  getSession,
  addTelegramSession,
  updateSessionId,
  updateSessionActivity,
} from "../sessions";
import type { SessionInfo } from "../sessions";

// Generate unique test names to avoid conflicts with persistent state
const uniqueId = () =>
  `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe("session-manager: basic operations", () => {
  test("getSessions returns an array", () => {
    const sessions = getSessions();
    expect(sessions).toBeArray();
  });

  test("setActiveSession returns false for non-existent session", () => {
    const result = setActiveSession(`non-existent-${uniqueId()}`);
    expect(result).toBe(false);
  });

  test("getSession returns null for non-existent session", () => {
    const session = getSession(`non-existent-${uniqueId()}`);
    expect(session).toBeNull();
  });
});

describe("session-manager: telegram sessions", () => {
  test("addTelegramSession creates session with generated name", () => {
    const path = `/tmp/test-project-${uniqueId()}`;
    const session = addTelegramSession(path);

    expect(session).toBeDefined();
    expect(session.dir).toBe(path);
    expect(session.source).toBe("telegram");
    expect(session.name).toBeTruthy();
    expect(session.lastActivity).toBeGreaterThan(0);
  });

  test("addTelegramSession uses explicit name when provided", () => {
    const name = `custom-${uniqueId()}`;
    const session = addTelegramSession(`/tmp/project-${uniqueId()}`, name);

    expect(session.name).toBe(name);
  });

  test("addTelegramSession sets it as active", () => {
    const name = `active-test-${uniqueId()}`;
    addTelegramSession(`/tmp/project-${uniqueId()}`, name);

    const active = getActiveSession();
    expect(active).not.toBeNull();
    expect(active!.name).toBe(name);
  });

  test("addTelegramSession generates unique names when no explicit name", () => {
    const baseName = `dup-${uniqueId()}`;
    // Both paths end with same directory name
    const session1 = addTelegramSession(`/path/to/${baseName}`);
    const session2 = addTelegramSession(`/another/path/${baseName}`);

    // First uses the directory name, second gets a suffix
    expect(session1.name).toBe(baseName);
    expect(session2.name).toBe(`${baseName}-2`);
  });

  test("addTelegramSession with explicit name overwrites existing", () => {
    const name = `overwrite-${uniqueId()}`;
    const session1 = addTelegramSession(`/path/one`, name);
    const session2 = addTelegramSession(`/path/two`, name);

    // Second call overwrites the first since same explicit name
    expect(session2.name).toBe(name);
    expect(session2.dir).toBe("/path/two");
    // Getting session by name returns the latest
    const retrieved = getSession(name);
    expect(retrieved!.dir).toBe("/path/two");
  });

  test("getSession retrieves telegram session by name", () => {
    const name = `retrieve-${uniqueId()}`;
    const path = `/tmp/project-${uniqueId()}`;
    addTelegramSession(path, name);

    const session = getSession(name);
    expect(session).not.toBeNull();
    expect(session!.dir).toBe(path);
  });

  test("updateSessionId updates session ID", () => {
    const name = `update-id-${uniqueId()}`;
    addTelegramSession(`/tmp/project-${uniqueId()}`, name);

    updateSessionId(name, "uuid-123-456");

    const session = getSession(name);
    expect(session!.id).toBe("uuid-123-456");
  });

  test("updateSessionId updates lastActivity", async () => {
    const name = `update-activity-${uniqueId()}`;
    const session = addTelegramSession(`/tmp/project-${uniqueId()}`, name);
    const originalActivity = session.lastActivity;

    await new Promise((r) => setTimeout(r, 10));
    updateSessionId(name, "uuid-789");

    const updated = getSession(name);
    expect(updated!.lastActivity).toBeGreaterThanOrEqual(originalActivity);
  });

  test("updateSessionActivity updates timestamp", async () => {
    const name = `activity-${uniqueId()}`;
    const session = addTelegramSession(`/tmp/project-${uniqueId()}`, name);
    const originalActivity = session.lastActivity;

    await new Promise((r) => setTimeout(r, 10));
    updateSessionActivity(name);

    const updated = getSession(name);
    expect(updated!.lastActivity).toBeGreaterThanOrEqual(originalActivity);
  });

  test("updateSessionId does nothing for non-existent session", () => {
    // Should not throw
    updateSessionId(`non-existent-${uniqueId()}`, "uuid-123");
  });

  test("updateSessionActivity does nothing for non-existent session", () => {
    // Should not throw
    updateSessionActivity(`non-existent-${uniqueId()}`);
  });
});

describe("session-manager: active session switching", () => {
  test("setActiveSession switches to existing session", () => {
    const name1 = `switch-1-${uniqueId()}`;
    const name2 = `switch-2-${uniqueId()}`;
    addTelegramSession(`/path/one-${uniqueId()}`, name1);
    addTelegramSession(`/path/two-${uniqueId()}`, name2);

    // name2 is now active (most recently added)
    expect(getActiveSession()!.name).toBe(name2);

    const result = setActiveSession(name1);

    expect(result).toBe(true);
    expect(getActiveSession()!.name).toBe(name1);
  });

  test("setActiveSession returns false for unknown session", () => {
    const name = `known-${uniqueId()}`;
    addTelegramSession(`/path/project-${uniqueId()}`, name);

    const result = setActiveSession(`unknown-${uniqueId()}`);

    expect(result).toBe(false);
    expect(getActiveSession()!.name).toBe(name); // unchanged
  });
});

describe("session-manager: watcher lifecycle", () => {
  afterEach(() => {
    stopWatcher();
  });

  test("startWatcher initializes without error", async () => {
    await startWatcher();
    // Should complete without throwing
  });

  test("stopWatcher cleans up resources", async () => {
    await startWatcher();
    stopWatcher();
    // Should not throw
  });

  test("stopWatcher is idempotent", () => {
    // Calling stop multiple times should not throw
    stopWatcher();
    stopWatcher();
    stopWatcher();
  });

  test("forceRefresh completes without error", async () => {
    await forceRefresh();
    // Should complete without throwing
  });
});

describe("session-manager: session discovery", () => {
  test("refresh preserves telegram sessions", async () => {
    const name = `preserved-${uniqueId()}`;
    addTelegramSession(`/tmp/telegram-project-${uniqueId()}`, name);

    await forceRefresh();

    const session = getSession(name);
    expect(session).not.toBeNull();
    expect(session!.source).toBe("telegram");
  });

  test("discovered sessions have desktop source", () => {
    // This tests that IF desktop sessions exist, they have the right source
    const sessions = getSessions();
    const desktopSessions = sessions.filter((s) => s.source === "desktop");

    for (const session of desktopSessions) {
      expect(session.source).toBe("desktop");
      expect(session.dir).toBeTruthy();
      expect(session.id).toBeTruthy();
    }
  });

  test("sessions are sorted by lastActivity descending", () => {
    const sessions = getSessions();

    for (let i = 1; i < sessions.length; i++) {
      expect(sessions[i - 1]!.lastActivity).toBeGreaterThanOrEqual(
        sessions[i]!.lastActivity,
      );
    }
  });
});

describe("session-manager: concurrent operations", () => {
  test("handles multiple rapid session additions", () => {
    const prefix = uniqueId();
    const initialCount = getSessions().length;

    // Add multiple sessions rapidly
    for (let i = 0; i < 5; i++) {
      addTelegramSession(
        `/path/project-${prefix}-${i}`,
        `session-${prefix}-${i}`,
      );
    }

    const sessions = getSessions();
    expect(sessions.length).toBe(initialCount + 5);
  });

  test("handles concurrent active session switches", () => {
    const prefix = uniqueId();
    const name1 = `rapid-1-${prefix}`;
    const name2 = `rapid-2-${prefix}`;
    const name3 = `rapid-3-${prefix}`;

    addTelegramSession(`/path/one-${prefix}`, name1);
    addTelegramSession(`/path/two-${prefix}`, name2);
    addTelegramSession(`/path/three-${prefix}`, name3);

    // Rapid switches
    setActiveSession(name1);
    setActiveSession(name2);
    setActiveSession(name3);
    setActiveSession(name1);

    // Should end on name1
    expect(getActiveSession()!.name).toBe(name1);
  });

  test("getSessions returns sorted by lastActivity", async () => {
    const prefix = uniqueId();
    const s1 = addTelegramSession(`/path/one-${prefix}`, `oldest-${prefix}`);
    await new Promise((r) => setTimeout(r, 5));
    const s2 = addTelegramSession(`/path/two-${prefix}`, `middle-${prefix}`);
    await new Promise((r) => setTimeout(r, 5));
    const s3 = addTelegramSession(`/path/three-${prefix}`, `newest-${prefix}`);

    const sessions = getSessions();
    const ourSessions = sessions.filter((s) => s.name.includes(prefix));

    // Should be newest first
    expect(ourSessions[0]!.name).toBe(`newest-${prefix}`);
    expect(ourSessions[1]!.name).toBe(`middle-${prefix}`);
    expect(ourSessions[2]!.name).toBe(`oldest-${prefix}`);
  });
});

describe("session-manager: pid assignment", () => {
  test("assigns pid when exactly one unmatched process exists for a directory", async () => {
    const { assignPidsToSessions } = await import("../sessions/watcher");

    const sessions: SessionInfo[] = [
      {
        id: "",
        name: "repo",
        dir: "/repo",
        lastActivity: 1,
        source: "desktop",
      },
    ];

    assignPidsToSessions(sessions, [{ pid: 101, ppid: 1, dir: "/repo" }]);

    expect(sessions[0]!.pid).toBe(101);
  });

  test("does not guess pid when multiple processes share a directory", async () => {
    const { assignPidsToSessions } = await import("../sessions/watcher");

    const sessions: SessionInfo[] = [
      {
        id: "",
        name: "repo-a",
        dir: "/repo",
        lastActivity: 1,
        source: "desktop",
      },
      {
        id: "",
        name: "repo-b",
        dir: "/repo",
        lastActivity: 2,
        source: "desktop",
      },
    ];

    assignPidsToSessions(sessions, [
      { pid: 101, ppid: 1, dir: "/repo" },
      { pid: 102, ppid: 1, dir: "/repo" },
    ]);

    expect(sessions[0]!.pid).toBeUndefined();
    expect(sessions[1]!.pid).toBeUndefined();
  });

  test("uses port files to disambiguate multiple sessions in same dir", async () => {
    const { assignPidsToSessions } = await import("../sessions/watcher");

    const sessions: SessionInfo[] = [
      {
        id: "aaaa-1111",
        name: "repo-a",
        dir: "/repo",
        lastActivity: 1,
        source: "desktop",
      },
      {
        id: "bbbb-2222",
        name: "repo-b",
        dir: "/repo",
        lastActivity: 2,
        source: "desktop",
      },
    ];

    const portFiles = [
      {
        port: 5001,
        pid: 901,
        ppid: 101,
        sessionId: "aaaa-1111",
        cwd: "/repo",
        startedAt: "",
      },
      {
        port: 5002,
        pid: 902,
        ppid: 102,
        sessionId: "bbbb-2222",
        cwd: "/repo",
        startedAt: "",
      },
    ];

    assignPidsToSessions(
      sessions,
      [
        { pid: 101, ppid: 1, dir: "/repo" },
        { pid: 102, ppid: 1, dir: "/repo" },
      ],
      portFiles,
    );

    expect(sessions[0]!.pid).toBe(101);
    expect(sessions[1]!.pid).toBe(102);
  });
});

describe("session-manager: edge cases", () => {
  test("handles empty directory path", () => {
    const session = addTelegramSession("", `empty-path-${uniqueId()}`);
    expect(session.name).toBeTruthy();
  });

  test("handles directory with special characters", () => {
    const name = `special-${uniqueId()}`;
    const session = addTelegramSession("/path/with spaces/and-dashes", name);
    expect(session.name).toBe(name);
    expect(session.dir).toBe("/path/with spaces/and-dashes");
  });

  test("session has required fields", () => {
    const name = `fields-${uniqueId()}`;
    const session = addTelegramSession(`/tmp/project-${uniqueId()}`, name);

    expect(session).toHaveProperty("id");
    expect(session).toHaveProperty("name");
    expect(session).toHaveProperty("dir");
    expect(session).toHaveProperty("lastActivity");
    expect(session).toHaveProperty("source");
  });

  test("new telegram session has empty id initially", () => {
    const name = `empty-id-${uniqueId()}`;
    const session = addTelegramSession(`/tmp/project-${uniqueId()}`, name);

    expect(session.id).toBe("");
  });
});
