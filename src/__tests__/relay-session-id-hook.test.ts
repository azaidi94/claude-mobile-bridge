/**
 * Unit tests for the SessionStart hook's pure pid→port-file attribution logic.
 *
 * The hook writes each Claude process's live session_id into ITS OWN relay port
 * file (matched by walking the hook's ancestry to the Claude pid = the relay's
 * ppid), giving exact + instant /clear follow without mtime/poll guessing. The
 * hook module guards execution with `import.meta.main`, so importing it here
 * runs no stdin/fs side effects — only the exported pure helpers.
 */

import "./ensure-test-env";
import { describe, expect, test } from "bun:test";

async function load() {
  return import(`${import.meta.dir}/../../hooks/claude-remote-session-id.ts`);
}

describe("ancestryChain", () => {
  test("returns ancestors closest-first, excluding self", async () => {
    const { ancestryChain } = await load();
    // 100 → 90 → 80 → 1(init)
    const ppid = new Map<number, number>([
      [100, 90],
      [90, 80],
      [80, 1],
    ]);
    expect(ancestryChain(100, (p: number) => ppid.get(p))).toEqual([90, 80]);
  });

  test("stops at an unknown parent", async () => {
    const { ancestryChain } = await load();
    const ppid = new Map<number, number>([[100, 90]]);
    expect(ancestryChain(100, (p: number) => ppid.get(p))).toEqual([90]);
  });

  test("guards against cycles", async () => {
    const { ancestryChain } = await load();
    const ppid = new Map<number, number>([
      [100, 90],
      [90, 100], // cycle
    ]);
    expect(ancestryChain(100, (p: number) => ppid.get(p))).toEqual([90]);
  });

  test("respects maxHops", async () => {
    const { ancestryChain } = await load();
    const ppid = (p: number) => p - 1; // infinite chain
    expect(ancestryChain(100, ppid, 3)).toEqual([99, 98, 97]);
  });
});

describe("selectPortFile", () => {
  const A = { file: "/s/a.json", cwd: "/proj", ppid: 80, sessionId: "a" };
  const B = { file: "/s/b.json", cwd: "/proj", ppid: 81, sessionId: "b" };
  const OTHER = { file: "/s/c.json", cwd: "/elsewhere", ppid: 82 };

  test("picks the cwd port file whose ppid is the closest ancestor", async () => {
    const { selectPortFile } = await load();
    // Ancestry passes through 81 (B's relay) then 80 (A's relay).
    expect(selectPortFile([A, B, OTHER], "/proj", [99, 81, 80])).toBe(B);
  });

  test("never matches a port file from another cwd", async () => {
    const { selectPortFile } = await load();
    expect(selectPortFile([OTHER], "/proj", [82])).toBeUndefined();
  });

  test("requires an ancestry match — never adopts a lone sibling relay", async () => {
    const { selectPortFile } = await load();
    // A session that fired the global hook but owns no relay must NOT hijack the
    // sole sibling relay in its dir — that's the cross-wire this guards against.
    expect(selectPortFile([A], "/proj", [999])).toBeUndefined();
  });

  test("returns undefined for 2+ relays in cwd with no ancestry match", async () => {
    const { selectPortFile } = await load();
    // Shared dir, ancestry walk failed → refuse to guess (poll fallback wins).
    expect(selectPortFile([A, B], "/proj", [999])).toBeUndefined();
  });

  test("ignores candidates lacking a ppid", async () => {
    const { selectPortFile } = await load();
    const noPpid = { file: "/s/x.json", cwd: "/proj", sessionId: "x" };
    expect(selectPortFile([noPpid], "/proj", [80])).toBeUndefined();
  });
});

describe("mergeSessionId", () => {
  test("overrides sessionId and preserves every other field", async () => {
    const { mergeSessionId } = await load();
    const current = {
      port: 5,
      pid: 10,
      ppid: 80,
      sessionId: "old",
      cwd: "/proj",
      sessionName: "proj",
      topicId: 42,
    };
    expect(mergeSessionId(current, "new")).toEqual({
      port: 5,
      pid: 10,
      ppid: 80,
      sessionId: "new",
      cwd: "/proj",
      sessionName: "proj",
      topicId: 42,
    });
  });

  test("keeps sessionId in its original key position (no reordering)", async () => {
    const { mergeSessionId } = await load();
    const current = { a: 1, sessionId: "old", b: 2 };
    expect(Object.keys(mergeSessionId(current, "new"))).toEqual([
      "a",
      "sessionId",
      "b",
    ]);
  });

  test("adds sessionId when absent", async () => {
    const { mergeSessionId } = await load();
    expect(mergeSessionId({ cwd: "/proj" }, "new")).toEqual({
      cwd: "/proj",
      sessionId: "new",
    });
  });
});
