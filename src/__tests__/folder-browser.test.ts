import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const replies: { text: string; opts: unknown }[] = [];
mock.module("../handlers/commands/helpers", () => ({
  busReply: async (_ctx: unknown, text: string, opts?: unknown) => {
    replies.push({ text, opts });
  },
}));
mock.module("../security", () => ({ isPathAllowed: () => true }));

import {
  browseFolder,
  parentWithinRoots,
  folderMenuSpec,
  handlePendingFolderText,
  FOLDER_ENTER_KIND,
  FOLDER_CREATE_KIND,
} from "../menus/folder-browser";
import { pendingFolderCreate } from "../menus/folder-pending";

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
    expect(spec.items.some((i) => i.kind === FOLDER_CREATE_KIND)).toBe(false);
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
    expect(spec.items[1]).toEqual({
      label: "➕ New folder…",
      kind: FOLDER_CREATE_KIND,
      payload: {
        dir: join(root, "gamma"),
        onPick: { kind: "new.spawn", extra: { fork: true } },
      },
    });
    expect(spec.items[2]?.label).toBe("📁 inner");
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
    expect(spec.items.length).toBe(2 + 3 + 25);
  });
});

describe("handlePendingFolderText", () => {
  const ctx = { chat: { id: 1 } } as never;
  const pick = { kind: "new.spawn" };
  beforeEach(() => {
    pendingFolderCreate.clear();
    replies.length = 0;
  });

  test("nothing pending → not handled", async () => {
    expect(await handlePendingFolderText(ctx, "k", "x", [root])).toBe(false);
  });

  test("creates the folder under the pending parent and opens the browser inside it", async () => {
    pendingFolderCreate.set("k", {
      parent: root,
      onPick: pick,
      createdAt: Date.now(),
    });
    expect(await handlePendingFolderText(ctx, "k", "fresh-proj", [root])).toBe(
      true,
    );
    expect((await stat(join(root, "fresh-proj"))).isDirectory()).toBe(true);
    // the menu shown is the browser INSIDE the new folder: Open here first
    const menu = replies.at(-1)!;
    expect(menu.text).toContain("fresh-proj");
    const kb = (
      menu.opts as { replyMarkup: { inline_keyboard: { text: string }[][] } }
    ).replyMarkup;
    expect(kb.inline_keyboard[0]?.[0]?.text).toBe("✅ Open here");
    expect(pendingFolderCreate.has("k")).toBe(false);
  });

  test("invalid name → error, still pending; then a valid retry works", async () => {
    pendingFolderCreate.set("k", {
      parent: root,
      onPick: pick,
      createdAt: Date.now(),
    });
    expect(await handlePendingFolderText(ctx, "k", "bad/name", [root])).toBe(
      true,
    );
    expect(replies.at(-1)?.text).toContain("slashes");
    expect(pendingFolderCreate.has("k")).toBe(true);
    expect(await handlePendingFolderText(ctx, "k", "ok-name", [root])).toBe(
      true,
    );
    expect((await stat(join(root, "ok-name"))).isDirectory()).toBe(true);
  });

  test("existing folder → informs and opens it", async () => {
    pendingFolderCreate.set("k", {
      parent: root,
      onPick: pick,
      createdAt: Date.now(),
    });
    expect(await handlePendingFolderText(ctx, "k", "beta", [root])).toBe(true);
    expect(replies[0]?.text).toContain("already exists");
    expect(replies.at(-1)?.text).toContain("beta");
  });

  test("a parent outside the roots is refused", async () => {
    pendingFolderCreate.set("k", {
      parent: "/",
      onPick: pick,
      createdAt: Date.now(),
    });
    expect(await handlePendingFolderText(ctx, "k", "nope", [root])).toBe(true);
    expect(replies.at(-1)?.text).toContain("outside the allowed paths");
  });

  test("/cancel", async () => {
    pendingFolderCreate.set("k", {
      parent: root,
      onPick: pick,
      createdAt: Date.now(),
    });
    expect(await handlePendingFolderText(ctx, "k", "/cancel", [root])).toBe(
      true,
    );
    expect(replies.at(-1)?.text).toContain("Cancelled");
  });
});
