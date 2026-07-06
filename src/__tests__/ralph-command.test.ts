import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir, homedir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";

// Force desktop-spawn support so the already-running path is reached on any
// platform (config reads this at load time; set before the dynamic import).
process.env.TELEGRAM_BOT_DESKTOP_SPAWN_ANY_PLATFORM = "1";

// Capture outbound bus messages.
const sends: { content: string }[] = [];
mock.module("../messaging", () => ({
  getMessageBus: () => ({
    send: async (m: { content: string }) => {
      sends.push(m);
      return { messageId: 1 };
    },
    edit: async () => ({}),
  }),
  setMessageBus: () => {},
  createMessageBus: () => ({}),
}));

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ralph-cmd-"));
  process.env.RALPH_STORE_PATH = join(testDir, "ralph.json");
  sends.length = 0;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.RALPH_STORE_PATH;
});

async function loadCmd() {
  const store = await import("../ralph/store");
  store._resetRalphStoreForTesting();
  const cmd = await import("../handlers/commands/ralph");
  return { store, cmd };
}

function mkCtx(text: string, userId = 1) {
  return {
    from: { id: userId },
    chat: { id: 789, type: "private" },
    message: { text, message_id: 1 },
    api: { createForumTopic: async () => ({ message_thread_id: 5 }) },
  } as any;
}

function baseLoop(over: Record<string, unknown> = {}) {
  return {
    id: "seed",
    repoPath: "/tmp/repo",
    iterations: 10,
    prMode: false,
    runDir: join(testDir, "run-seed"),
    tailOffset: 0,
    verbose: false,
    startedAt: "2026-07-05T00:00:00.000Z",
    ...over,
  };
}

describe("parseStartArgs", () => {
  it("defaults iterations to 10", async () => {
    const { cmd } = await loadCmd();
    expect(cmd.parseStartArgs("/tmp/x")).toEqual({
      path: "/tmp/x",
      iterations: 10,
      prMode: false,
      label: undefined,
    });
  });

  it("parses N, -pr and -l label in any order", async () => {
    const { cmd } = await loadCmd();
    expect(cmd.parseStartArgs("-pr /tmp/x -l bug 5")).toEqual({
      path: "/tmp/x",
      iterations: 5,
      prMode: true,
      label: "bug",
    });
  });

  it("errors on missing path", async () => {
    const { cmd } = await loadCmd();
    expect(cmd.parseStartArgs("5 -pr")).toEqual({ error: "need a repo path" });
  });

  it("rejects 0 iterations", async () => {
    const { cmd } = await loadCmd();
    expect(cmd.parseStartArgs("/tmp/x 0")).toEqual({
      error: "iterations must be ≥ 1",
    });
  });
});

describe("expandHome", () => {
  it("expands ~ and ~/sub", async () => {
    const { cmd } = await loadCmd();
    expect(cmd.expandHome("~")).toBe(homedir());
    expect(cmd.expandHome("~/proj")).toBe(join(homedir(), "proj"));
    expect(cmd.expandHome("/abs")).toBe("/abs");
  });
});

describe("handleRalph", () => {
  it("rejects unauthorized users", async () => {
    const { cmd } = await loadCmd();
    await cmd.handleRalph(mkCtx("/ralph", 999));
    expect(sends.at(-1)?.content).toContain("Unauthorized");
  });

  it("reports no loop on /ralph stop when none running", async () => {
    const { cmd } = await loadCmd();
    await cmd.handleRalph(mkCtx("/ralph stop"));
    expect(sends.at(-1)?.content).toContain("No loop running");
  });

  it("rejects start when a loop is already active", async () => {
    const { store, cmd } = await loadCmd();
    await store.addLoop(baseLoop({ state: "running", pid: 1 }));
    await cmd.handleRalph(mkCtx("/ralph /tmp/other 5"));
    expect(sends.at(-1)?.content).toContain("already running");
  });

  it("shows usage-style status when idle", async () => {
    const { cmd } = await loadCmd();
    await cmd.handleRalph(mkCtx("/ralph"));
    expect(sends.at(-1)?.content).toContain("No loop running");
  });
});
