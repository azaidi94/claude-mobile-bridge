import "./ensure-test-env";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "tasks-watcher-"));
});

afterEach(async () => {
  const { __resetForTests } = await import("../web/tasks/watcher");
  await __resetForTests();
  rmSync(TMP, { recursive: true, force: true });
});

async function loadWatcher() {
  return import("../web/tasks/watcher");
}

function waitFor<T>(check: () => T | undefined, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const i = setInterval(() => {
      const v = check();
      if (v !== undefined) {
        clearInterval(i);
        resolve(v);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(i);
        reject(new Error("timeout"));
      }
    }, 25);
  });
}

describe("tasks watcher", () => {
  test("emits task.upsert when a new task file is added", async () => {
    mkdirSync(join(TMP, "tasks"), { recursive: true });
    const { subscribe, ready } = await loadWatcher();
    const events: any[] = [];
    const unsub = subscribe(TMP, (e) => events.push(e));
    await ready(TMP);

    const sid = "ffff1111-2222-3333-4444-555566667777";
    const sDir = join(TMP, "tasks", sid);
    mkdirSync(sDir, { recursive: true });
    writeFileSync(
      join(sDir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "hello",
        description: "",
        activeForm: "",
        status: "pending",
        blocks: [],
        blockedBy: [],
      }),
    );

    const upsert = await waitFor(() =>
      events.find((e) => e.type === "task.upsert"),
    );
    expect(upsert.sessionId).toBe(sid);
    expect(upsert.task.subject).toBe("hello");
    unsub();
  });

  test("emits task.delete when a task file is unlinked", async () => {
    const sid = "gggg1111-2222-3333-4444-555566667777";
    const sDir = join(TMP, "tasks", sid);
    mkdirSync(sDir, { recursive: true });
    const file = join(sDir, "1.json");
    writeFileSync(
      file,
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

    const { subscribe, ready } = await loadWatcher();
    const events: any[] = [];
    const unsub = subscribe(TMP, (e) => events.push(e));
    await ready(TMP);
    unlinkSync(file);

    const del = await waitFor(() =>
      events.find((e) => e.type === "task.delete"),
    );
    expect(del.sessionId).toBe(sid);
    expect(del.taskId).toBe("1");
    unsub();
  });

  test("emits session.delete when a session dir is removed", async () => {
    const sid = "hhhh1111-2222-3333-4444-555566667777";
    const sDir = join(TMP, "tasks", sid);
    mkdirSync(sDir, { recursive: true });

    const { subscribe, ready } = await loadWatcher();
    const events: any[] = [];
    const unsub = subscribe(TMP, (e) => events.push(e));
    await ready(TMP);
    rmdirSync(sDir);

    const del = await waitFor(() =>
      events.find((e) => e.type === "session.delete"),
    );
    expect(del.sessionId).toBe(sid);
    unsub();
  });
});
