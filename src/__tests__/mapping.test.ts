process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "1";

import { describe, test, expect } from "bun:test";
import type { PortFileData } from "../relay/discovery";

async function loadMapping() {
  return import("../sessions/mapping");
}

const BASE: PortFileData = {
  port: 12345,
  pid: 73988,
  ppid: 73928,
  cwd: "/Users/azaidi/Projects/foo",
  startedAt: "2026-05-04T15:12:26.609Z",
};

describe("resolveSessionMapping", () => {
  test("returns null when sessionId is absent", async () => {
    const { resolveSessionMapping } = await loadMapping();
    expect(resolveSessionMapping({ ...BASE })).toBeNull();
  });

  test("returns null when sessionName is absent", async () => {
    const { resolveSessionMapping } = await loadMapping();
    expect(
      resolveSessionMapping({
        ...BASE,
        sessionId: "0111828c-21b2-4a3b-9999-000000000001",
      }),
    ).toBeNull();
  });

  test("returns full mapping when sessionId and sessionName present", async () => {
    const { resolveSessionMapping } = await loadMapping();
    const pf: PortFileData = {
      ...BASE,
      sessionId: "0111828c-21b2-4a3b-9999-000000000001",
      sessionName: "foo-2",
    };
    const result = resolveSessionMapping(pf);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("0111828c-21b2-4a3b-9999-000000000001");
    expect(result!.sessionName).toBe("foo-2");
    expect(result!.relayPid).toBe(73988);
    expect(result!.relayPort).toBe(12345);
    expect(result!.claudePid).toBe(73928);
    expect(result!.cwd).toBe("/Users/azaidi/Projects/foo");
    expect(result!.topicId).toBeUndefined();
    expect(result!.topicName).toBeUndefined();
  });

  test("includes topicId and topicName when present (group setup)", async () => {
    const { resolveSessionMapping } = await loadMapping();
    const result = resolveSessionMapping({
      ...BASE,
      sessionId: "0111828c-21b2-4a3b-9999-000000000002",
      sessionName: "foo",
      topicId: 26248,
      topicName: "foo",
    });
    expect(result!.topicId).toBe(26248);
    expect(result!.topicName).toBe("foo");
  });

  test("topicId absent for DM setup", async () => {
    const { resolveSessionMapping } = await loadMapping();
    const result = resolveSessionMapping({
      ...BASE,
      sessionId: "0111828c-21b2-4a3b-9999-000000000003",
      sessionName: "foo",
    });
    expect(result!.topicId).toBeUndefined();
    expect(result!.topicName).toBeUndefined();
  });

  test("claudePid is undefined when ppid absent", async () => {
    const { resolveSessionMapping } = await loadMapping();
    const pf: PortFileData = {
      port: 12345,
      pid: 73988,
      cwd: "/p",
      startedAt: "2026-05-04T00:00:00Z",
      sessionId: "0111828c-21b2-4a3b-9999-000000000004",
      sessionName: "foo",
    };
    expect(resolveSessionMapping(pf)!.claudePid).toBeUndefined();
  });
});
