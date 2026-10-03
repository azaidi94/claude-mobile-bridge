import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  browseFolder,
  parentWithinRoots,
  folderMenuSpec,
  FOLDER_ENTER_KIND,
} from "../menus/folder-browser";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fb-"));
  for (const d of ["beta", "Alpha", "node_modules", ".git", "gamma/inner"]) {
    await mkdir(join(root, d), { recursive: true });
  }
  await writeFile(join(root, "file.txt"), "x");
});
afterEach(async () => rm(root, { recursive: true, force: true }));

describe("browseFolder", () => {
  test("lists only visible directories, sorted case-insensitively", async () => {
    const r = await browseFolder(root, [root]);
    expect(r.isRoot).toBe(false);
    expect(r.subdirs.map((s) => s.split("/").pop())).toEqual([
      "Alpha",
      "beta",
      "gamma",
    ]);
  });

  test("null dir lists the allowed roots that exist", async () => {
    const r = await browseFolder(null, [root, "/definitely/not/here"]);
    expect(r.isRoot).toBe(true);
    expect(r.dir).toBe("");
    expect(r.subdirs).toEqual([root]);
  });

  test("cannot browse above an allowed root", async () => {
    await expect(browseFolder(join(root, ".."), [root])).rejects.toThrow(
      "outside allowed roots",
    );
    await expect(browseFolder("/", [root])).rejects.toThrow(
      "outside allowed roots",
    );
  });

  test("a sibling that merely shares the root's prefix is outside", async () => {
    await expect(browseFolder(root + "-other", [root])).rejects.toThrow(
      "outside allowed roots",
    );
  });
});

describe("parentWithinRoots", () => {
  test("parent of a nested dir", () => {
    expect(parentWithinRoots(join(root, "gamma", "inner"), [root])).toBe(
      join(root, "gamma"),
    );
  });
  test("a root itself has no parent (Up hidden)", () => {
    expect(parentWithinRoots(root, [root])).toBeNull();
  });
});

describe("folderMenuSpec", () => {
  test("root listing: no Open-here, no Up, roots as items", async () => {
    const spec = folderMenuSpec(
      await browseFolder(null, [root]),
      { kind: "new.spawn" },
      [root],
    );
    expect(spec.items[0]?.kind).toBe(FOLDER_ENTER_KIND);
    expect(spec.items.some((i) => i.label.startsWith("✅"))).toBe(false);
    expect(spec.back).toBeUndefined();
  });

  test("inside a folder: Open-here first with the pick payload, subdirs, and Up to the parent", async () => {
    const spec = folderMenuSpec(
      await browseFolder(join(root, "gamma"), [root]),
      { kind: "new.spawn", extra: { fork: true } },
      [root],
    );
    expect(spec.items[0]).toEqual({
      label: "✅ Open here",
      kind: "new.spawn",
      payload: { fork: true, dir: join(root, "gamma") },
    });
    expect(spec.items[1]?.label).toBe("📁 inner");
    expect(spec.back?.kind).toBe(FOLDER_ENTER_KIND);
    expect((spec.back?.payload as { dir: string }).dir).toBe(root);
  });

  test("at a root, Up goes back to the roots listing (dir null)", async () => {
    const spec = folderMenuSpec(
      await browseFolder(root, [root]),
      { kind: "k" },
      [root],
    );
    expect((spec.back?.payload as { dir: string | null }).dir).toBeNull();
  });

  test("pages at 10", async () => {
    for (let i = 0; i < 25; i++)
      await mkdir(join(root, `d${String(i).padStart(2, "0")}`));
    const spec = folderMenuSpec(
      await browseFolder(root, [root]),
      { kind: "k" },
      [root],
    );
    expect(spec.pageSize).toBe(10);
    expect(spec.items.length).toBe(1 + 3 + 25);
  });
});
