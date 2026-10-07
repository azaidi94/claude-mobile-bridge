/**
 * Folder browser supplier for the menu component.
 *
 * Lets a phone user walk the allowed roots (ALLOWED_PATHS) one level at a
 * time and pick a folder without typing a path. Hidden entries (dot-dirs,
 * node_modules, __pycache__) are skipped. Navigation never escapes a root.
 */

import { readdir, stat, mkdir } from "fs/promises";
import { join, dirname, basename, resolve } from "path";
import { homedir } from "os";
import { ALLOWED_PATHS } from "../config";
import {
  registerMenuKind,
  replaceMenu,
  showMenu,
  type MenuSpec,
  type MenuItem,
} from "./menu";
import { busReply } from "../handlers/commands/helpers";
import { isPathAllowed } from "../security";
import { pendingFolderCreate, takePendingFolderName } from "./folder-pending";
import type { Context } from "grammy";

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
export const FOLDER_CREATE_KIND = "folder.create";

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
  if (!res.isRoot) {
    items.push({
      label: "➕ New folder…",
      kind: FOLDER_CREATE_KIND,
      payload: { dir: res.dir, onPick },
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

/** Registers "folder.create": ask for a name; the next message creates it. */
export function registerFolderCreateMenu(): void {
  registerMenuKind(FOLDER_CREATE_KIND, async (ctx, entry) => {
    const { dir, onPick } = entry.payload as {
      dir: string;
      onPick: FolderPick;
    };
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    // Lazy: streaming.ts drags in the messaging stack.
    const { pendingKey } = await import("../handlers/streaming");
    pendingFolderCreate.set(pendingKey(chatId, ctx.msg?.message_thread_id), {
      parent: dir,
      onPick,
      createdAt: Date.now(),
    });
    await ctx.answerCallbackQuery().catch(() => {});
    await busReply(
      ctx,
      `✏️ Name for the new folder in <code>${escapeHtmlLite(displayPath(dir))}</code>?\n(or /cancel)`,
      "html",
    );
  });
}

/**
 * Text-handler hook: if a "New folder…" prompt is pending for `key`, consume
 * `message` as the name. Returns true when the message was handled.
 */
export async function handlePendingFolderText(
  ctx: Context,
  key: string,
  message: string,
  roots: readonly string[] = ALLOWED_PATHS,
): Promise<boolean> {
  const outcome = takePendingFolderName(key, message);
  if (!outcome) return false;
  if (outcome.kind === "cancel") {
    await busReply(ctx, "✖ Cancelled.");
    return true;
  }
  if (outcome.kind === "invalid") {
    await busReply(ctx, `❌ ${outcome.reason} Try again, or /cancel.`);
    return true;
  }
  const target = join(outcome.parent, outcome.name);
  if (!isPathAllowed(target) || !roots.some((r) => underRoot(target, r))) {
    await busReply(ctx, "❌ That folder would be outside the allowed paths.");
    return true;
  }
  try {
    await mkdir(target, { recursive: false });
  } catch (e) {
    const code = (e as { code?: string }).code;
    await busReply(
      ctx,
      code === "EEXIST"
        ? `ℹ️ <code>${escapeHtmlLite(outcome.name)}</code> already exists — opening it.`
        : `❌ Couldn't create the folder: <code>${escapeHtmlLite(String(e))}</code>`,
      "html",
    );
    if (code !== "EEXIST") return true;
  }
  await showMenu(
    ctx,
    folderMenuSpec(await browseFolder(target, roots), outcome.onPick, roots),
  );
  return true;
}
