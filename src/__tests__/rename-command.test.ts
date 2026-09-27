import { describe, test, expect, beforeEach, mock } from "bun:test";

// --- registries under test (real modules) ---
import {
  renameSessionState,
  getSessionState,
  dropSessionState,
} from "../sessions/session-state";
import { renameWatchesByName, watches } from "../handlers/watch/registry";
import { isValidSessionName } from "../handlers/commands/rename";

describe("isValidSessionName", () => {
  test("accepts watcher-style names", () => {
    for (const n of ["my_repo", "rem-engine", "a", "proj.v2", "X9-_."]) {
      expect(isValidSessionName(n)).toBe(true);
    }
  });
  test("rejects empty, leading punctuation, spaces, slashes, and >40 chars", () => {
    for (const n of [
      "",
      "-x",
      ".x",
      "a b",
      "a/b",
      "a".repeat(41),
      "émoji",
      "a\nb",
    ]) {
      expect(isValidSessionName(n)).toBe(false);
    }
  });
});

describe("renameSessionState", () => {
  beforeEach(() => {
    dropSessionState("old");
    dropSessionState("new");
    dropSessionState("taken");
  });
  test("re-keys the state and updates its sessionName", () => {
    const s = getSessionState("old");
    expect(renameSessionState("old", "new")).toBe(true);
    expect(getSessionState("new")).toBe(s);
    expect(s.sessionName).toBe("new");
  });
  test("re-runs the on-create hook so per-name listeners attach under the new name", async () => {
    const { setOnSessionStateCreated } =
      await import("../sessions/session-state");
    const seen: (string | null)[] = [];
    setOnSessionStateCreated((st) => seen.push(st.sessionName));
    try {
      getSessionState("old"); // hook fires with "old"
      expect(renameSessionState("old", "new")).toBe(true);
      expect(seen).toEqual(["old", "new"]);
    } finally {
      setOnSessionStateCreated(null);
    }
  });

  test("refuses when the target name exists or the source does not", () => {
    getSessionState("old");
    getSessionState("taken");
    expect(renameSessionState("old", "taken")).toBe(false);
    expect(renameSessionState("missing", "new")).toBe(false);
  });
});

describe("renameWatchesByName", () => {
  beforeEach(() => watches.clear());
  test("relabels every watch bound to the old name, re-subscribing cross-post", () => {
    let unsubbed = 0;
    const oldUnsub = () => {
      unsubbed++;
    };
    const mk = (sessionName: string, threadId: number) =>
      ({ sessionName, chatId: 1, threadId, unsubCrossPost: oldUnsub }) as never;
    watches.set("k1" as never, mk("old", 2));
    watches.set("k2" as never, mk("old", 3));
    watches.set("k3" as never, mk("other", 4));
    expect(renameWatchesByName("old", "new", {} as never)).toBe(2);
    const names = [...watches.values()]
      .map((w) => (w as { sessionName: string }).sessionName)
      .sort();
    expect(names).toEqual(["new", "new", "other"]);
    expect(unsubbed).toBe(2);
    for (const k of ["k1", "k2"]) {
      const w = watches.get(k as never) as { unsubCrossPost?: () => void };
      expect(typeof w.unsubCrossPost).toBe("function");
      expect(w.unsubCrossPost).not.toBe(oldUnsub);
      w.unsubCrossPost?.();
    }
  });
});

describe("watcher.renameSession", () => {
  test("re-keys the cached session, keeps the same object, moves the active pointer", async () => {
    const w = await import("../sessions/watcher");
    // addTelegramSession is the public way to seed the cache in tests.
    const name = w.addTelegramSession(
      "/tmp/rename-test-dir",
      "sess-rename-1",
    ).name;
    w.setActiveSession(name);
    const before = w.getSession(name);
    expect(before).not.toBeNull();
    expect(w.renameSession(name, "renamed-1")).toBe(true);
    expect(w.getSession(name)).toBeNull();
    expect(w.getSession("renamed-1")).toBe(before);
    expect(before!.name).toBe("renamed-1");
    expect(w.getActiveSessionName()).toBe("renamed-1");
    // collisions and unknown sources are refused
    const other = w.addTelegramSession(
      "/tmp/rename-test-dir-2",
      "sess-rename-2",
    ).name;
    expect(w.renameSession(other, "renamed-1")).toBe(false);
    expect(w.renameSession("nope", "x")).toBe(false);
    w.removeSession("renamed-1");
    w.removeSession(other);
  });
});

describe("handleRename (handler flow)", () => {
  const replies: string[] = [];
  const editForumTopic = mock(
    async (_c: number, _t: number, _o: { name: string }) => true,
  );

  function ctx(text: string, threadId = 77) {
    return {
      from: { id: 123456 },
      chat: { id: -100, type: "supergroup" },
      message: { text, message_thread_id: threadId },
      api: { editForumTopic },
    };
  }

  const portFiles: { pid: number; sessionId?: string; cwd: string }[] = [];
  const updatePortFile = mock(async (_pid: number, _u: object) => {});

  beforeEach(async () => {
    replies.length = 0;
    editForumTopic.mockClear();
    updatePortFile.mockClear();
    portFiles.length = 0;
    mock.module("../relay/discovery", () => ({
      scanPortFiles: async () => portFiles,
      updatePortFile,
      renameRelayClients: () => 0,
    }));
    mock.module("../config", () => ({ ALLOWED_USERS: [123456] }));
    mock.module("../handlers/commands/helpers", () => ({
      busReply: async (_ctx: unknown, content: string) => {
        replies.push(content);
      },
    }));
  });

  test("rejects outside a topic, empty and invalid names, and same-name", async () => {
    const { handleRename } = await import("../handlers/commands/rename");
    await handleRename(ctx("/rename x") as never, undefined);
    expect(replies.at(-1)).toContain("inside the session topic");
    const sctx = {
      topicId: 77,
      source: "cc",
      sessionName: "old",
      sessionId: "s",
      sessionDir: "/d",
      chatId: -100,
    } as never;
    await handleRename(ctx("/rename") as never, sctx);
    expect(replies.at(-1)).toContain("Usage");
    await handleRename(ctx("/rename bad name") as never, sctx);
    expect(replies.at(-1)).toContain("Name must be");
    await handleRename(ctx("/rename old") as never, sctx);
    expect(replies.at(-1)).toContain("Already named");
    expect(editForumTopic).not.toHaveBeenCalled();
  });

  test("refuses a name that only exists as a lazily created SessionState", async () => {
    const { handleRename } = await import("../handlers/commands/rename");
    getSessionState("ghost-state");
    const sctx = {
      topicId: 77,
      source: "cc",
      sessionName: "old",
      sessionId: "s",
      sessionDir: "/d",
      chatId: -100,
    } as never;
    await handleRename(ctx("/rename ghost-state") as never, sctx);
    expect(replies.at(-1)).toContain("already in use");
    expect(editForumTopic).not.toHaveBeenCalled();
    dropSessionState("ghost-state");
  });

  test("reverts the Telegram title when the cached session is gone", async () => {
    const { handleRename } = await import("../handlers/commands/rename");
    const sctx = {
      topicId: 77,
      source: "cc",
      sessionName: "vanished",
      sessionId: "s",
      sessionDir: "/d",
      chatId: -100,
    } as never;
    await handleRename(ctx("/rename fresh") as never, sctx);
    expect(editForumTopic.mock.calls.map((c) => c[2])).toEqual([
      { name: "fresh" },
      { name: "vanished" },
    ]);
    expect(replies.at(-1)).toContain("nothing was changed");
  });

  test("writes sessionName and topicName into the session's relay port file", async () => {
    const { handleRename } = await import("../handlers/commands/rename");
    const w = await import("../sessions/watcher");
    const name = w.addTelegramSession(
      "/tmp/rename-test-dir-5",
      "sess-rename-5",
    ).name;
    portFiles.push({
      pid: 4242,
      sessionId: "sid-5",
      cwd: "/tmp/rename-test-dir-5",
    });
    const sctx = {
      topicId: 77,
      source: "cc",
      sessionName: name,
      sessionId: "sid-5",
      sessionDir: "/tmp/rename-test-dir-5",
      chatId: -100,
    } as never;
    await handleRename(ctx("/rename portly") as never, sctx);
    expect(updatePortFile).toHaveBeenCalledWith(4242, {
      sessionName: "portly",
      topicName: "portly",
    });
    w.removeSession("portly");
    dropSessionState("portly");
  });

  test("changes nothing when Telegram refuses", async () => {
    const { handleRename } = await import("../handlers/commands/rename");
    const w = await import("../sessions/watcher");
    const name = w.addTelegramSession(
      "/tmp/rename-test-dir-3",
      "sess-rename-3",
    ).name;
    editForumTopic.mockImplementationOnce(async () => {
      throw new Error("TOPIC_NOT_MODIFIED");
    });
    const sctx = {
      topicId: 77,
      source: "cc",
      sessionName: name,
      sessionId: "s",
      sessionDir: "/d",
      chatId: -100,
    } as never;
    await handleRename(ctx("/rename fresh-name") as never, sctx);
    expect(replies.at(-1)).toContain("Telegram refused");
    expect(w.getSession(name)).not.toBeNull();
    expect(w.getSession("fresh-name")).toBeNull();
    w.removeSession(name);
  });

  test("happy path renames Telegram topic, cache, state and watches", async () => {
    const { handleRename } = await import("../handlers/commands/rename");
    const w = await import("../sessions/watcher");
    const name = w.addTelegramSession(
      "/tmp/rename-test-dir-4",
      "sess-rename-4",
    ).name;
    getSessionState(name);
    watches.clear();
    watches.set("k" as never, { sessionName: name } as never);
    const sctx = {
      topicId: 77,
      source: "cc",
      sessionName: name,
      sessionId: "s",
      sessionDir: "/d",
      chatId: -100,
    } as never;
    await handleRename(ctx("/rename shiny") as never, sctx);
    expect(editForumTopic).toHaveBeenCalledWith(-100, 77, { name: "shiny" });
    expect(replies.at(-1)).toContain("Renamed");
    expect(w.getSession("shiny")).not.toBeNull();
    expect(w.getSession(name)).toBeNull();
    expect(getSessionState("shiny").sessionName).toBe("shiny");
    expect(
      (watches.get("k" as never) as { sessionName: string }).sessionName,
    ).toBe("shiny");
    w.removeSession("shiny");
    dropSessionState("shiny");
  });
});
