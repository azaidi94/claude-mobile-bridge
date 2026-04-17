/**
 * Unit tests for watch handler state management and formatStatusMessage isWatching.
 *
 * Tests watch state lifecycle, isWatching/stopWatching helpers,
 * notifySessionOffline, and the new isWatching status format.
 */

import "./ensure-test-env";
import { describe, expect, test, mock } from "bun:test";

mock.module("../settings", () => ({
  getWorkingDir: () => "/tmp/test-working-dir",
  getTerminal: () => "terminal" as const,
  getAutoWatchOnSpawn: () => true,
  getDefaultModelSetting: () => undefined,
  getOverrides: () => ({}),
  saveSetting: mock(() => Promise.resolve()),
  _reloadForTests: mock(() => {}),
}));

// Import directly from source to avoid barrel export issues
import {
  formatStatusMessage,
  type StatusInfo,
} from "../sessions/status-message";

// ============== formatStatusMessage with isWatching ==============

describe("watch: formatStatusMessage isWatching", () => {
  test("formats watching state correctly", () => {
    const status: StatusInfo = {
      sessionName: null,
      isPlanMode: false,
      model: "Opus 4.6",
      isWatching: "my-project",
    };

    const result = formatStatusMessage(status);
    expect(result).toBe("👁 Watching: my-project | Opus 4.6");
  });

  test("watching state includes branch", () => {
    const status: StatusInfo = {
      sessionName: null,
      isPlanMode: false,
      model: "Sonnet 4.6",
      branch: "main",
      isWatching: "my-project",
    };

    const result = formatStatusMessage(status);
    expect(result).toBe("👁 Watching: my-project | Sonnet 4.6 | 🌿 main");
  });

  test("watching state ignores isPlanMode and sessionName", () => {
    const status: StatusInfo = {
      sessionName: "other-session",
      isPlanMode: true,
      model: "Opus 4.6",
      isWatching: "watched-session",
    };

    const result = formatStatusMessage(status);
    // Should show watching, not the session name or plan mode
    expect(result).toContain("👁 Watching: watched-session");
    expect(result).not.toContain("other-session");
    expect(result).not.toContain("Plan");
  });

  test("isWatching null falls back to normal format", () => {
    const status: StatusInfo = {
      sessionName: "my-project",
      isPlanMode: false,
      model: "Opus 4.6",
      isWatching: null,
    };

    const result = formatStatusMessage(status);
    expect(result).toBe("✅ my-project | ⚡ Normal | Opus 4.6");
  });

  test("isWatching undefined falls back to normal format", () => {
    const status: StatusInfo = {
      sessionName: "my-project",
      isPlanMode: false,
      model: "Opus 4.6",
    };

    const result = formatStatusMessage(status);
    expect(result).toBe("✅ my-project | ⚡ Normal | Opus 4.6");
  });
});

// ============== Watch state management ==============
// These tests import directly from the handler module.
// Since the watch module depends on grammy types at import time,
// we test the pure logic through formatStatusMessage and parseLine
// which don't require grammy. Integration tests for isWatching/
// stopWatching/notifySessionOffline would require a full bot mock.

describe("watch: state management (via exports)", () => {
  test("isWatching and stopWatching are exported", async () => {
    // Verify the handler module exports are available
    const mod = await import("../handlers/watch");
    expect(typeof mod.isWatching).toBe("function");
    expect(typeof mod.stopWatching).toBe("function");
    expect(typeof mod.notifySessionOffline).toBe("function");
    expect(typeof mod.handleWatch).toBe("function");
    expect(typeof mod.handleUnwatch).toBe("function");
  });

  test("isWatching returns false for unknown chat", async () => {
    const { isWatching } = await import("../handlers/watch");
    expect(isWatching(999999999)).toBe(false);
  });

  test("stopWatching returns undefined for unknown chat", async () => {
    const { stopWatching } = await import("../handlers/watch");
    const result = stopWatching(999999999);
    expect(result).toBeUndefined();
  });
});
