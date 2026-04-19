import "./ensure-test-env";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "tasks-reader-"));
  process.env.CLAUDE_DIR = TMP;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.CLAUDE_DIR;
});

async function loadReader() {
  return import("../web/tasks/reader");
}

describe("readSnapshot", () => {
  test("returns empty snapshot when tasks dir does not exist", async () => {
    const { readSnapshot } = await loadReader();
    const snap = await readSnapshot(TMP);
    expect(snap).toEqual({ sessions: [], tasks: [] });
  });

  test("reads tasks from a session directory", async () => {
    const sid = "aaaa1111-2222-3333-4444-555566667777";
    const dir = join(TMP, "tasks", sid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "First task",
        description: "desc",
        activeForm: "Doing first task",
        status: "pending",
        blocks: [],
        blockedBy: [],
      }),
    );
    writeFileSync(
      join(dir, "2.json"),
      JSON.stringify({
        id: "2",
        subject: "Second task",
        description: "",
        activeForm: "",
        status: "completed",
        blocks: [],
        blockedBy: [],
      }),
    );

    const { readSnapshot } = await loadReader();
    const snap = await readSnapshot(TMP);
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0]!.id).toBe(sid);
    expect(snap.tasks).toHaveLength(2);
    expect(snap.tasks.map((t) => t.subject).sort()).toEqual([
      "First task",
      "Second task",
    ]);
    expect(snap.tasks[0]!.updatedAt).toBeGreaterThan(0);
  });

  test("skips malformed JSON without throwing", async () => {
    const sid = "bbbb1111-2222-3333-4444-555566667777";
    const dir = join(TMP, "tasks", sid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1.json"), "not json {");
    writeFileSync(
      join(dir, "2.json"),
      JSON.stringify({
        id: "2",
        subject: "Good",
        description: "",
        activeForm: "",
        status: "pending",
        blocks: [],
        blockedBy: [],
      }),
    );

    const { readSnapshot } = await loadReader();
    const snap = await readSnapshot(TMP);
    expect(snap.tasks).toHaveLength(1);
    expect(snap.tasks[0]!.subject).toBe("Good");
  });

  test("derives session name from project jsonl cwd", async () => {
    const sid = "cccc1111-2222-3333-4444-555566667777";
    const encoded = "-Users-test-my-project";
    const tasksDir = join(TMP, "tasks", sid);
    const projectsDir = join(TMP, "projects", encoded);
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(
      join(tasksDir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "x",
        description: "",
        activeForm: "",
        status: "pending",
        blocks: [],
        blockedBy: [],
      }),
    );
    writeFileSync(
      join(projectsDir, `${sid}.jsonl`),
      JSON.stringify({
        type: "user",
        cwd: "/Users/test/my-project",
        message: { role: "user", content: "hi" },
      }) + "\n",
    );

    const { readSnapshot } = await loadReader();
    const snap = await readSnapshot(TMP);
    expect(snap.sessions[0]!.name).toBe("my-project");
    expect(snap.sessions[0]!.projectDir).toBe("/Users/test/my-project");
  });
});

describe("readSessionTask", () => {
  test("parses a single task JSON file", async () => {
    const sid = "dddd1111-2222-3333-4444-555566667777";
    const dir = join(TMP, "tasks", sid);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "1.json");
    writeFileSync(
      file,
      JSON.stringify({
        id: "1",
        subject: "Read me",
        description: "long desc",
        activeForm: "Reading",
        status: "in_progress",
        blocks: [],
        blockedBy: [],
      }),
    );

    const { readSessionTask } = await loadReader();
    const task = await readSessionTask(sid, file);
    expect(task).not.toBeNull();
    expect(task!.id).toBe("1");
    expect(task!.subject).toBe("Read me");
    expect(task!.status).toBe("in_progress");
    expect(task!.sessionId).toBe(sid);
  });

  test("returns null for malformed file", async () => {
    const sid = "eeee1111-2222-3333-4444-555566667777";
    const dir = join(TMP, "tasks", sid);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "1.json");
    writeFileSync(file, "broken");

    const { readSessionTask } = await loadReader();
    const task = await readSessionTask(sid, file);
    expect(task).toBeNull();
  });
});
