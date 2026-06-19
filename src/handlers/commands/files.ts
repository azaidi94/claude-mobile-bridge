/**
 * Filesystem navigation commands: /pwd, /cd, /ls.
 */

import { readdir, stat } from "fs/promises";
import { resolve } from "path";
import type { Context } from "grammy";
import { escapeHtml } from "../../formatting";
import { ALLOWED_USERS } from "../../config";
import { getWorkingDir } from "../../settings";
import { isAuthorized, rateLimiter, isPathAllowed } from "../../security";
import { getSessionState } from "../../sessions/session-state";
import type { SessionContext } from "../../sessions/context";
import { busReply } from "./helpers";

/**
 * /pwd - Show current working directory.
 */
export async function handlePwd(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  const [allowed, retryAfter] = rateLimiter.check(userId!);
  if (!allowed) {
    await busReply(ctx, `⏳ Rate limited. Wait ${retryAfter!.toFixed(1)}s.`);
    return;
  }

  const state =
    sctx && sctx.source === "cc" ? getSessionState(sctx.sessionName) : null;
  const dir = state?.workingDir || sctx?.sessionDir || getWorkingDir();
  await busReply(ctx, `📁 <code>${escapeHtml(dir)}</code>`, "html");
}

/**
 * /cd <path> - Change working directory.
 *
 * Validates the path exists, is a directory, and is within allowed paths.
 */
export async function handleCd(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  const [allowed, retryAfter] = rateLimiter.check(userId!);
  if (!allowed) {
    await busReply(ctx, `⏳ Rate limited. Wait ${retryAfter!.toFixed(1)}s.`);
    return;
  }

  const state =
    sctx && sctx.source === "cc" ? getSessionState(sctx.sessionName) : null;
  const rawPath = ((ctx.match as string | undefined) ?? "").trim();

  if (!rawPath) {
    await busReply(ctx, "Usage: /cd &lt;path&gt;", "html");
    return;
  }

  // resolve() normalizes ../segments and handles both absolute and relative paths
  const targetPath = resolve(
    state?.workingDir || sctx?.sessionDir || getWorkingDir(),
    rawPath,
  );

  // Validate path is allowed
  if (!isPathAllowed(targetPath)) {
    await busReply(ctx, "❌ Path not in allowed directories.");
    return;
  }

  // Validate path exists and is a directory
  try {
    const stats = await stat(targetPath);
    if (!stats.isDirectory()) {
      await busReply(ctx, "❌ Not a directory.");
      return;
    }
  } catch {
    await busReply(ctx, "❌ Path does not exist.");
    return;
  }

  if (state) state.setWorkingDir(targetPath);
  // No-sctx path: /cd is a per-session concept; without a session we cannot
  // persist the new dir. Surface the path but leave global default unchanged.
  await busReply(
    ctx,
    `📂 Now in: <code>${escapeHtml(targetPath)}</code>`,
    "html",
  );
}

/**
 * /ls [path] - List directory contents.
 *
 * Defaults to current working directory. Shows folders and files with indicators.
 */
export async function handleLs(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await busReply(ctx, "Unauthorized.");
    return;
  }

  const [allowed, retryAfter] = rateLimiter.check(userId!);
  if (!allowed) {
    await busReply(ctx, `⏳ Rate limited. Wait ${retryAfter!.toFixed(1)}s.`);
    return;
  }

  const state =
    sctx && sctx.source === "cc" ? getSessionState(sctx.sessionName) : null;
  const baseDir = state?.workingDir || sctx?.sessionDir || getWorkingDir();
  const rawPath = ((ctx.match as string | undefined) ?? "").trim();

  // resolve() normalizes ../segments and handles both absolute and relative paths
  const targetPath = rawPath ? resolve(baseDir, rawPath) : baseDir;

  // Validate path is allowed
  if (!isPathAllowed(targetPath)) {
    await busReply(ctx, "❌ Path not in allowed directories.");
    return;
  }

  try {
    const entries = await readdir(targetPath, { withFileTypes: true });

    if (entries.length === 0) {
      await busReply(
        ctx,
        `📁 <code>${escapeHtml(targetPath)}</code>\n\n<i>(empty)</i>`,
        "html",
      );
      return;
    }

    // Sort: directories first, then symlinks, then files, all alphabetical
    const sorted = entries.sort((a, b) => {
      const aIsDir = a.isDirectory();
      const bIsDir = b.isDirectory();
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.name.localeCompare(b.name);
    });

    const lines: string[] = [`📁 <code>${escapeHtml(targetPath)}</code>\n`];

    for (const entry of sorted.slice(0, 50)) {
      let icon: string;
      let suffix = "";
      if (entry.isDirectory()) {
        icon = "📂";
        suffix = "/";
      } else if (entry.isSymbolicLink()) {
        icon = "🔗";
      } else {
        icon = "📄";
      }
      lines.push(`${icon} <code>${escapeHtml(entry.name)}${suffix}</code>`);
    }

    if (entries.length > 50) {
      lines.push(`\n<i>... and ${entries.length - 50} more</i>`);
    }

    await busReply(ctx, lines.join("\n"), "html");
  } catch {
    await busReply(ctx, "❌ Cannot read directory.");
  }
}
