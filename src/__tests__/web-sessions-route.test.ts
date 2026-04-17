import { describe, test, expect } from "bun:test";

async function loadSessions() {
  process.env.TELEGRAM_BOT_TOKEN ||= "test";
  process.env.TELEGRAM_ALLOWED_USERS ||= "1";
  return import("../web/routes/sessions");
}

describe("serializeSessions", () => {
  test("maps SessionInfo to API shape", async () => {
    const { serializeSessions } = await loadSessions();
    const sessions = new Map([
      [
        "my-project",
        {
          id: "abc123",
          name: "my-project",
          dir: "/home/user/my-project",
          lastActivity: 1700000000000,
          source: "desktop" as const,
          pid: 1234,
        },
      ],
    ]);
    const result = serializeSessions(sessions);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "abc123",
      name: "my-project",
      dir: "/home/user/my-project",
      source: "desktop",
      live: true,
    });
  });

  test("sorts by lastActivity descending", async () => {
    const { serializeSessions } = await loadSessions();
    const sessions = new Map([
      [
        "old",
        {
          id: "1",
          name: "old",
          dir: "/old",
          lastActivity: 1000,
          source: "desktop" as const,
        },
      ],
      [
        "new",
        {
          id: "2",
          name: "new",
          dir: "/new",
          lastActivity: 9000,
          source: "desktop" as const,
        },
      ],
    ]);
    const result = serializeSessions(sessions);
    expect(result[0]!.name).toBe("new");
    expect(result[1]!.name).toBe("old");
  });
});
