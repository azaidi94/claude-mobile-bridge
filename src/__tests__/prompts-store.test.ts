import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "prompts-test-"));
  process.env.PROMPTS_STORE_PATH = join(testDir, "prompts.json");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.PROMPTS_STORE_PATH;
});

async function fresh() {
  const m = await import("../prompts/store");
  m._resetPromptStoreForTesting();
  return m;
}

describe("prompt store", () => {
  it("empty by default", async () => {
    const m = await fresh();
    expect(await m.getPrompts()).toEqual([]);
  });

  it("addPrompt persists with generated id", async () => {
    const m = await fresh();
    const p = await m.addPrompt({ label: "tests", text: "/run tests" });
    expect(p.id).toBeTruthy();
    expect((await m.getPrompts())[0]?.label).toBe("tests");
  });

  it("removePrompt removes by id", async () => {
    const m = await fresh();
    const p = await m.addPrompt({ label: "x", text: "y" });
    expect(await m.removePrompt(p.id)).toBe(true);
    expect(await m.getPrompts()).toHaveLength(0);
    expect(await m.removePrompt("missing")).toBe(false);
  });

  it("scope filtering: unscoped + matching session shown, others hidden", async () => {
    const m = await fresh();
    await m.addPrompt({ label: "global", text: "g" });
    await m.addPrompt({ label: "proj-only", text: "p", sessionScope: "proj" });
    await m.addPrompt({
      label: "other-only",
      text: "o",
      sessionScope: "other",
    });
    const inProj = await m.getPrompts("proj");
    const inOther = await m.getPrompts("other");
    const unscoped = await m.getPrompts();
    expect(inProj.map((p) => p.label).sort()).toEqual(["global", "proj-only"]);
    expect(inOther.map((p) => p.label).sort()).toEqual([
      "global",
      "other-only",
    ]);
    expect(unscoped.map((p) => p.label)).toEqual(["global"]);
  });

  it("getById returns the prompt", async () => {
    const m = await fresh();
    const p = await m.addPrompt({ label: "x", text: "hello" });
    expect((await m.getById(p.id))?.text).toBe("hello");
    expect(await m.getById("nope")).toBeUndefined();
  });
});
