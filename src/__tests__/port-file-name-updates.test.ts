import { describe, test, expect } from "bun:test";
import type { SessionInfo } from "../sessions/types";
import type { PortFileData } from "../relay/discovery";
import { portFileNameUpdates } from "../sessions/watcher";

const si = (o: Partial<SessionInfo>): SessionInfo => ({
  id: "",
  name: "s",
  dir: "/p",
  lastActivity: 0,
  source: "desktop",
  ...o,
});
const pf = (o: Partial<PortFileData>): PortFileData =>
  ({
    port: 1,
    pid: 100,
    ppid: 99,
    cwd: "/p",
    startedAt: "2026-01-01T00:00:00Z",
    ...o,
  }) as PortFileData;

describe("portFileNameUpdates", () => {
  // Regression: the watcher rewrote sessionName into every port file on EVERY
  // refresh unconditionally. The write tripped the watcher's own STATE_DIR
  // file-watch → another refresh → another write → a ~1/sec self-trigger loop.
  // A no-op write (name already correct) must produce no update.
  test("no update when the port file already has the session's name", () => {
    const updates = portFileNameUpdates(
      [si({ id: "sid-a", name: "alpha", pid: 99 })],
      [pf({ pid: 100, ppid: 99, sessionId: "sid-a", sessionName: "alpha" })],
    );
    expect(updates).toEqual([]);
  });

  test("update when the name differs, matched by sessionId", () => {
    const updates = portFileNameUpdates(
      [si({ id: "sid-a", name: "renamed", pid: 99 })],
      [pf({ pid: 100, ppid: 99, sessionId: "sid-a", sessionName: "old" })],
    );
    expect(updates).toEqual([{ relayPid: 100, sessionName: "renamed" }]);
  });

  test("matches by dir+ppid when the session has no id", () => {
    const updates = portFileNameUpdates(
      [si({ id: "", name: "beta", dir: "/proj", pid: 42 })],
      [pf({ pid: 200, ppid: 42, cwd: "/proj", sessionName: undefined })],
    );
    expect(updates).toEqual([{ relayPid: 200, sessionName: "beta" }]);
  });

  test("skips non-desktop sessions and sessions with no name", () => {
    const updates = portFileNameUpdates(
      [
        si({ id: "sid-c", name: "gamma", pid: 99, source: "cursor" }),
        si({ id: "sid-d", name: "", pid: 99 }),
      ],
      [
        pf({ pid: 100, ppid: 99, sessionId: "sid-c", sessionName: "x" }),
        pf({ pid: 101, ppid: 99, sessionId: "sid-d", sessionName: "y" }),
      ],
    );
    expect(updates).toEqual([]);
  });

  test("skips a session with no matching port file", () => {
    const updates = portFileNameUpdates(
      [si({ id: "sid-z", name: "zeta", pid: 7 })],
      [pf({ pid: 100, ppid: 99, sessionId: "sid-a", sessionName: "alpha" })],
    );
    expect(updates).toEqual([]);
  });
});
