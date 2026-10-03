/**
 * Folder browser supplier for the menu component.
 *
 * Lets a phone user walk the allowed roots (ALLOWED_PATHS) one level at a
 * time and pick a folder without typing a path. Hidden entries (dot-dirs,
 * node_modules, __pycache__) are skipped. Navigation never escapes a root.
 */

import { readdir, stat } from "fs/promises";
import { join, dirname, basename, resolve } from "path";
import { homedir } from "os";
import { ALLOWED_PATHS } from "../config";
import {
  registerMenuKind,
  replaceMenu,
  type MenuSpec,
  type MenuItem,
} from "./menu";

export interface FolderBrowseResult {
  /** "" for the virtual root listing. */
  dir: string;
  subdirs: string[];
  isRoot: boolean;
}

/** How a supplier wants "✅ Open here" to be dispatched. */
export interface FolderPick {
  kind: string;
  /** Extra fields merged into the pick payload next to `dir`. */
  extra?: Record<string, unknown>;
}

const HIDDEN = new Set(["node_modules", "__pycache__", "dist", "build"]);
export const FOLDER_PAGE_SIZE = 10;
export const FOLDER_ENTER_KIND = "folder.enter";

function underRoot(dir: string, root: string): boolean {
  const d = resolve(dir);
  const r = resolve(root);
  return d === r || d.startsWith(r.endsWith("/") ? r : r + "/");
}

export function parentWithinRoots(
  dir: string,
  roots: readonly string[] = ALLOWED_PATHS,
): string | null {
  const d = resolve(dir);
  if (roots.some((r) => resolve(r) === d)) return null;
  const parent = dirname(d);
  return roots.some((r) => underRoot(parent, r)) ? parent : null;
}

export async function browseFolder(
  dir: string | null,
  roots: readonly string[] = ALLOWED_PATHS,
): Promise<FolderBrowseResult> {
  if (dir === null || dir === "") {
    const existing: string[] = [];
    for (const r of roots) {
      const st = await stat(r).catch(() => null);
      if (st?.isDirectory()) existing.push(resolve(r));
    }
    return { dir: "", subdirs: existing, isRoot: true };
  }
  const d = resolve(dir);
  if (!roots.some((r) => underRoot(d, r))) {
    throw new Error(`outside allowed roots: ${dir}`);
  }
  const names = await readdir(d);
  const subdirs: string[] = [];
  for (const name of names) {
    if (name.startsWith(".") || HIDDEN.has(name)) continue;
    const st = await stat(join(d, name)).catch(() => null);
    if (st?.isDirectory()) subdirs.push(join(d, name));
  }
  subdirs.sort((a, b) =>
    basename(a).localeCompare(basename(b), undefined, { sensitivity: "base" }),
  );
  return { dir: d, subdirs, isRoot: false };
}

export function displayPath(p: string): string {
  const home = homedir();
  return p === home
    ? "~"
    : p.startsWith(home + "/")
      ? "~" + p.slice(home.length)
      : p;
}

export function folderMenuSpec(
  res: FolderBrowseResult,
  onPick: FolderPick,
  roots: readonly string[] = ALLOWED_PATHS,
): MenuSpec {
  const items: MenuItem[] = [];
  if (!res.isRoot) {
    items.push({
      label: "✅ Open here",
      kind: onPick.kind,
      payload: { ...(onPick.extra ?? {}), dir: res.dir },
    });
  }
  for (const sub of res.subdirs) {
    items.push({
      label: `📁 ${res.isRoot ? displayPath(sub) : basename(sub)}`,
      kind: FOLDER_ENTER_KIND,
      payload: { dir: sub, onPick },
    });
  }
  const spec: MenuSpec = {
    title: res.isRoot
      ? "📂 Pick a folder"
      : `📂 <code>${escapeHtmlLite(displayPath(res.dir))}</code>`,
    items,
    pageSize: FOLDER_PAGE_SIZE,
  };
  if (!res.isRoot) {
    const parent = parentWithinRoots(res.dir, roots);
    spec.back = {
      label: "⬆️ Up",
      kind: FOLDER_ENTER_KIND,
      payload: { dir: parent, onPick },
    };
  }
  return spec;
}

function escapeHtmlLite(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Registers the "folder.enter" kind: drill into a folder (or back to roots). */
export function registerFolderMenu(): void {
  registerMenuKind(FOLDER_ENTER_KIND, async (ctx, entry) => {
    const { dir, onPick } = entry.payload as {
      dir: string | null;
      onPick: FolderPick;
    };
    let res: FolderBrowseResult;
    try {
      res = await browseFolder(dir);
    } catch {
      await ctx
        .answerCallbackQuery({ text: "That folder isn't allowed." })
        .catch(() => {});
      return;
    }
    await replaceMenu(ctx, folderMenuSpec(res, onPick));
    await ctx.answerCallbackQuery().catch(() => {});
  });
}
