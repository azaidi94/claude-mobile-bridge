import { test, expect } from "bun:test";
import {
  launchUuidByClaudePid,
  launchUuidBySessionId,
  type RegistryRecord,
} from "../sessions/registry";

const r = (o: Partial<RegistryRecord>): RegistryRecord => ({
  launchUuid: "u",
  claudePid: 1,
  startTime: "T",
  sessionId: "s",
  cwd: "/a",
  source: "startup",
  updatedAt: "2026-01-01T00:00:00Z",
  ...o,
});

test("launchUuidByClaudePid indexes pid → launchUuid", () => {
  const m = launchUuidByClaudePid([r({ claudePid: 100, launchUuid: "A" })]);
  expect(m.get(100)).toBe("A");
});

test("on duplicate claudePid, keeps the latest updatedAt", () => {
  const m = launchUuidByClaudePid([
    r({ claudePid: 100, launchUuid: "OLD", updatedAt: "2026-01-01T00:00:00Z" }),
    r({ claudePid: 100, launchUuid: "NEW", updatedAt: "2026-06-01T00:00:00Z" }),
  ]);
  expect(m.get(100)).toBe("NEW");
});

test("launchUuidBySessionId indexes sessionId → launchUuid, latest wins, skips id-less", () => {
  const m = launchUuidBySessionId([
    r({ sessionId: "s1", launchUuid: "A" }),
    r({ sessionId: "s1", launchUuid: "A2", updatedAt: "2026-06-01T00:00:00Z" }),
    r({ sessionId: "", launchUuid: "IGNORED" }),
  ]);
  expect(m.get("s1")).toBe("A2");
  expect(m.has("")).toBe(false);
});
