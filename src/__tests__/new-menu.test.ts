import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const replies: string[] = [];
mock.module("../handlers/commands/helpers", () => ({
  busReply: async (_ctx: unknown, text: string) => {
    replies.push(text);
  },
}));

import {
  newMenuSpec,
  liveSessionsMenuSpec,
  branchableSessions,
  NEW_HOME_KIND,
  transcriptsMenuSpec,
  encodeProjectDir,
  registerNewMenu,
  NEW_SPAWN_KIND,
  NEW_PICK_LIVE_KIND,
  NEW_PICK_TRANSCRIPT_KIND,
} from "../menus/new-menu";
import { FOLDER_ENTER_KIND } from "../menus/folder-browser";
import { handleMenuCallback, _resetMenuKindsForTests } from "../menus/menu";
import { putToken, _resetMenuRegistryForTests } from "../menus/registry";

const SID = "62d0fa2e-bee6-4068-96fe-b41c96d6ce18";
const live = [
  {
    name: "kx_repo",
    dir: "/p/kx_repo",
    id: SID,
    source: "desktop",
    lastActivity: 0,
  },
  { name: "tg-only", dir: "/p/x", id: "", source: "telegram", lastActivity: 0 },
] as never[];

describe("encodeProjectDir", () => {
  test("matches Claude Code's project folder naming", () => {
    expect(encodeProjectDir("/Users/a/Projects/kx2/kx_repo")).toBe(
      "-Users-a-Projects-kx2-kx-repo",
    );
    expect(encodeProjectDir("/Users/a/VoiceInk-2.11")).toBe(
      "-Users-a-VoiceInk-2-11",
    );
  });
});

describe("newMenuSpec", () => {
  test("in a CC topic: open folder, branch THIS session (resume+fork), resume", () => {
    const sctx = {
      sessionId: SID,
      sessionDir: "/p/kx_repo",
      sessionName: "kx_repo",
      source: "cc",
      chatId: 1,
      topicId: 5,
    } as never;
    const spec = newMenuSpec(sctx, []);
    expect(spec.items.map((i) => i.kind)).toEqual([
      FOLDER_ENTER_KIND,
      NEW_SPAWN_KIND,
      FOLDER_ENTER_KIND,
    ]);
    expect(spec.items[1]?.payload).toEqual({
      dir: "/p/kx_repo",
      resume: SID,
      fork: true,
    });
    expect(spec.items[1]?.label).toContain("kx_repo");
  });
  test("in General with live sessions: 'Branch a session…' picker", () => {
    const spec = newMenuSpec(undefined, live);
    expect(spec.items[1]?.kind).toBe(NEW_PICK_LIVE_KIND);
  });
  test("in General with only non-branchable sessions (Cursor / no id): no branch entry", () => {
    const only = [
      {
        name: "cur",
        dir: "/p/c",
        id: "cursor-x",
        source: "cursor",
        lastActivity: 0,
      },
      { name: "noid", dir: "/p/n", id: "", source: "desktop", lastActivity: 0 },
    ] as never[];
    expect(branchableSessions(only)).toEqual([]);
    const spec = newMenuSpec(undefined, only);
    expect(spec.items.some((i) => i.kind === NEW_PICK_LIVE_KIND)).toBe(false);
  });

  test("in General with no live sessions: no branch entry", () => {
    const spec = newMenuSpec(undefined, []);
    expect(spec.items.map((i) => i.kind)).toEqual([
      FOLDER_ENTER_KIND,
      FOLDER_ENTER_KIND,
    ]);
  });
  test("resume entry drills the folder browser with the transcript pick kind", () => {
    const spec = newMenuSpec(undefined, []);
    expect(spec.items.at(-1)?.payload).toEqual({
      dir: null,
      onPick: { kind: NEW_PICK_TRANSCRIPT_KIND },
    });
  });
});

describe("liveSessionsMenuSpec", () => {
  test("lists desktop sessions with ids as resume+fork spawns", () => {
    const spec = liveSessionsMenuSpec(live, true);
    expect(spec.items).toEqual([
      {
        label: "kx_repo · /p/kx_repo",
        kind: NEW_SPAWN_KIND,
        payload: { dir: "/p/kx_repo", resume: SID, fork: true },
      },
    ]);
    expect(spec.back?.kind).toBe(NEW_HOME_KIND);
  });
});

describe("transcriptsMenuSpec", () => {
  let projects: string;
  beforeEach(async () => {
    projects = await mkdtemp(join(tmpdir(), "nm-"));
  });
  afterEach(async () => rm(projects, { recursive: true, force: true }));

  test("newest first, carries ids, previews the last message", async () => {
    const dir = "/p/kx_repo";
    const proj = join(projects, encodeProjectDir(dir));
    await mkdir(proj, { recursive: true });
    const row = (t: string) =>
      `{"type":"user","message":{"role":"user","content":"${t}"},"cwd":"${dir}"}\n`;
    await writeFile(
      join(proj, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl"),
      row("older one"),
    );
    await Bun.sleep(10);
    await writeFile(
      join(proj, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl"),
      row("newer one"),
    );
    const spec = await transcriptsMenuSpec(dir, projects);
    expect(
      spec.items.map((i) => (i.payload as { resume: string }).resume),
    ).toEqual([
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    ]);
    expect(spec.items[0]?.label).toContain("newer one");
    expect(spec.items[0]?.kind).toBe(NEW_SPAWN_KIND);
  });

  test("empty folder → no items and a 'none found' title", async () => {
    const spec = await transcriptsMenuSpec("/p/none", projects);
    expect(spec.items).toEqual([]);
    expect(spec.title).toContain("No conversations");
  });
});

describe("new.spawn handler", () => {
  const spawn = mock(async () => {});
  const scan = mock(async () => [] as never[]);
  const answers: unknown[] = [];
  const edits: string[] = [];
  const ctx = {
    chat: { id: 1 },
    from: { id: 42 },
    api: {},
    answerCallbackQuery: async (o?: unknown) => {
      answers.push(o ?? {});
    },
    editMessageText: async (t: string) => {
      edits.push(t);
    },
  };

  beforeEach(() => {
    _resetMenuRegistryForTests();
    _resetMenuKindsForTests();
    spawn.mockClear();
    scan.mockClear();
    scan.mockImplementation(async () => [] as never[]);
    answers.length = 0;
    edits.length = 0;
    registerNewMenu({
      spawn: spawn as never,
      scan: scan as never,
      sessions: () => live as never,
      allowed: (d) => !d.startsWith("/forbidden"),
    });
  });

  test("plain folder pick spawns without options", async () => {
    const t = putToken({
      kind: NEW_SPAWN_KIND,
      payload: { dir: "/p/x" },
      chatId: 1,
    });
    await handleMenuCallback(ctx as never, t);
    expect(spawn).toHaveBeenCalledWith({}, 1, "/p/x", 42, undefined);
    expect(edits[0]).toContain("Spawning");
  });

  test("branch pick spawns with resume + fork", async () => {
    const t = putToken({
      kind: NEW_SPAWN_KIND,
      payload: { dir: "/p/kx_repo", resume: SID, fork: true },
      chatId: 1,
    });
    await handleMenuCallback(ctx as never, t);
    expect(spawn).toHaveBeenCalledWith({}, 1, "/p/kx_repo", 42, {
      resumeSessionId: SID,
      fork: true,
    });
    expect(edits[0]).toContain("Branching");
  });

  test("resume of a live id is refused with an alert", async () => {
    scan.mockImplementation(
      async () => [{ sessionId: SID, sessionName: "kx_repo-2" }] as never[],
    );
    const t = putToken({
      kind: NEW_SPAWN_KIND,
      payload: { dir: "/p/kx_repo", resume: SID },
      chatId: 1,
    });
    await handleMenuCallback(ctx as never, t);
    expect(spawn).not.toHaveBeenCalled();
    expect(answers[0]).toMatchObject({ show_alert: true });
    expect(String((answers[0] as { text: string }).text)).toContain(
      "kx_repo-2",
    );
  });

  test("resume of a dormant id spawns with resume only", async () => {
    const t = putToken({
      kind: NEW_SPAWN_KIND,
      payload: { dir: "/p/kx_repo", resume: SID },
      chatId: 1,
    });
    await handleMenuCallback(ctx as never, t);
    expect(spawn).toHaveBeenCalledWith({}, 1, "/p/kx_repo", 42, {
      resumeSessionId: SID,
      fork: false,
    });
    expect(edits[0]).toContain("Resuming");
  });

  test("a dir outside the allow-list is refused before spawning", async () => {
    const t = putToken({
      kind: NEW_SPAWN_KIND,
      payload: { dir: "/forbidden/x", resume: SID, fork: true },
      chatId: 1,
    });
    await handleMenuCallback(ctx as never, t);
    expect(spawn).not.toHaveBeenCalled();
    expect(answers[0]).toMatchObject({ show_alert: true });
  });

  test("Back from the live picker returns to the top-level /new menu", async () => {
    const t = putToken({ kind: NEW_HOME_KIND, payload: null, chatId: 1 });
    await handleMenuCallback(ctx as never, t);
    expect(edits[0]).toBe("🚀 New session");
  });

  test("live picker replaces the message with the session list", async () => {
    const t = putToken({
      kind: NEW_PICK_LIVE_KIND,
      payload: { fork: true },
      chatId: 1,
    });
    await handleMenuCallback(ctx as never, t);
    expect(edits[0]).toContain("Branch which session?");
  });
});
