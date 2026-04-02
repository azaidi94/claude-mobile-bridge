/**
 * Unit tests for relay discovery target selection.
 */

import { describe, expect, test } from "bun:test";

async function loadRelayDiscovery() {
  process.env.TELEGRAM_BOT_TOKEN ||= "test";
  process.env.TELEGRAM_ALLOWED_USERS ||= "1";
  return import("../relay/discovery");
}

describe("relay discovery: selectRelayTarget", () => {
  test("prefers exact session id match", async () => {
    const { selectRelayTarget } = await loadRelayDiscovery();
    type PortFileData = import("../relay/discovery").PortFileData;
    const relays: PortFileData[] = [
      {
        port: 1,
        pid: 11,
        ppid: 101,
        sessionId: "session-a",
        cwd: "/repo",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        port: 2,
        pid: 12,
        ppid: 102,
        sessionId: "session-b",
        cwd: "/repo",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const target = selectRelayTarget(relays, {
      sessionId: "session-b",
      sessionDir: "/repo",
    });

    expect(target?.port).toBe(2);
  });

  test("uses exact parent pid match when session id is unavailable", async () => {
    const { selectRelayTarget } = await loadRelayDiscovery();
    type PortFileData = import("../relay/discovery").PortFileData;
    const relays: PortFileData[] = [
      {
        port: 1,
        pid: 11,
        ppid: 101,
        cwd: "/repo",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        port: 2,
        pid: 12,
        ppid: 102,
        cwd: "/repo",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const target = selectRelayTarget(relays, {
      sessionDir: "/repo",
      claudePid: 102,
    });

    expect(target?.port).toBe(2);
  });

  test("refuses ambiguous cwd-only matches", async () => {
    const { selectRelayTarget } = await loadRelayDiscovery();
    type PortFileData = import("../relay/discovery").PortFileData;
    const relays: PortFileData[] = [
      {
        port: 1,
        pid: 11,
        ppid: 101,
        cwd: "/repo",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        port: 2,
        pid: 12,
        ppid: 102,
        cwd: "/repo",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const target = selectRelayTarget(relays, {
      sessionDir: "/repo",
    });

    expect(target).toBeNull();
  });

  test("does not fall back to cwd when a specific session id is missing", async () => {
    const { selectRelayTarget } = await loadRelayDiscovery();
    type PortFileData = import("../relay/discovery").PortFileData;
    const relays: PortFileData[] = [
      {
        port: 1,
        pid: 11,
        ppid: 101,
        sessionId: "session-a",
        cwd: "/repo",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const target = selectRelayTarget(relays, {
      sessionId: "missing-session",
      sessionDir: "/repo",
    });

    expect(target).toBeNull();
  });
});
