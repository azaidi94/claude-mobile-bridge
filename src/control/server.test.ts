import { test, expect } from "bun:test";
import { handleControl, topicLink, type ControlDeps } from "./server";

const SID = "a70657a8-a196-46e2-ae7a-f24d92fb4315";

const deps = (o: Partial<ControlDeps> = {}): ControlDeps => ({
  pid: 42,
  startedAt: "2026-10-15T13:00:00.000Z",
  chatId: () => -1003728746073,
  sessions: () => [
    { id: SID, name: "cmb", dir: "/d/cmb", lastActivity: 1, source: "desktop" },
    { id: "", name: "noid", dir: "/d/x", lastActivity: 1, source: "desktop" },
  ],
  topics: () => [
    {
      topicId: 281131,
      sessionName: "cmb",
      sessionDir: "/d/cmb",
      sessionId: SID,
      isOnline: true,
      createdAt: "t",
    },
  ],
  ...o,
});

test("topicLink: supergroup ids only", () => {
  expect(topicLink(-1003728746073, 7)).toBe("https://t.me/c/3728746073/7");
  expect(topicLink(12345, 7)).toBeUndefined();
  expect(topicLink(undefined, 7)).toBeUndefined();
});

test("/status lists the bot and its sessions with topic ids", () => {
  const { status, body } = handleControl("/status", deps());
  expect(status).toBe(200);
  expect(body).toEqual({
    pid: 42,
    startedAt: "2026-10-15T13:00:00.000Z",
    chatId: -1003728746073,
    sessions: [
      {
        id: SID,
        name: "cmb",
        dir: "/d/cmb",
        source: "desktop",
        topicId: 281131,
      },
      { id: "", name: "noid", dir: "/d/x", source: "desktop", topicId: null },
    ],
  });
});

test("/session/<id> returns the session and its topic link", () => {
  expect(handleControl(`/session/${SID}`, deps()).body).toEqual({
    session: { name: "cmb", dir: "/d/cmb", source: "desktop" },
    topic: {
      topicId: 281131,
      name: "cmb",
      isOnline: true,
      link: "https://t.me/c/3728746073/281131",
    },
  });
});

test("/session/<id> for a session the bot doesn't know", () => {
  expect(
    handleControl("/session/00000000-0000-0000-0000-000000000000", deps()).body,
  ).toEqual({ session: null, topic: null });
});

test("topic found by name when the mapping lacks a sessionId", () => {
  const body = handleControl(
    `/session/${SID}`,
    deps({
      topics: () => [
        {
          topicId: 9,
          sessionName: "cmb",
          sessionDir: "/d/cmb",
          isOnline: false,
          createdAt: "t",
        },
      ],
    }),
  ).body as { topic: { topicId: number } };
  expect(body.topic.topicId).toBe(9);
});

test("unknown paths 404", () => {
  expect(handleControl("/nope", deps()).status).toBe(404);
  expect(handleControl("/session/not-a-uuid", deps()).status).toBe(404);
});
