/**
 * `/new` button menu: open a folder, branch a live session, or resume a
 * dormant conversation — without typing paths or session ids.
 *
 * Every tap ends in `spawnDesktopClaudeSession`, exactly like the typed
 * forms (`/new <path>`, `/new --branch`, `/new --resume <id>`), so relay,
 * topic and watch wiring are unchanged.
 */

import { readdir, stat } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
import type { Context } from "grammy";
import type { SessionContext } from "../sessions/context";
import type { SessionInfo } from "../sessions/types";
import { getSessions } from "../sessions/watcher";
import { getLastSessionMessage } from "../sessions/tailer";
import { scanPortFiles } from "../relay";
import { formatTimeAgo, escapeHtml } from "../formatting";
import { spawnDesktopClaudeSession } from "../handlers/commands/spawn";
import type { SpawnOptions } from "../handlers/commands/terminal-launchers";
import { info } from "../logger";
import { isPathAllowed } from "../security";
import { registerMenuKind, replaceMenu, showMenu, type MenuSpec } from "./menu";
import {
  browseFolder,
  folderMenuSpec,
  displayPath,
  FOLDER_ENTER_KIND,
  type FolderPick,
} from "./folder-browser";

export const NEW_SPAWN_KIND = "new.spawn";
export const NEW_PICK_LIVE_KIND = "new.pick-live";
export const NEW_PICK_TRANSCRIPT_KIND = "new.pick-transcript";
export const TRANSCRIPT_LIMIT = 10;
export const NEW_HOME_KIND = "new.home";

/** Live sessions a fork can be made from: desktop Claudes with a known id. */
export function branchableSessions(live: SessionInfo[]): SessionInfo[] {
  return live.filter((s) => s.source === "desktop" && !!s.id);
}

export interface SpawnPayload {
  dir: string;
  resume?: string;
  fork?: boolean;
}

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/** Claude Code's project folder name for a cwd: every non-alphanumeric → "-". */
export function encodeProjectDir(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, "-");
}

export function newMenuSpec(
  sctx: SessionContext | undefined,
  live: SessionInfo[],
): MenuSpec {
  const openPick: FolderPick = { kind: NEW_SPAWN_KIND };
  const resumePick: FolderPick = { kind: NEW_PICK_TRANSCRIPT_KIND };
  const spec: MenuSpec = {
    title: "🚀 New session",
    items: [
      {
        label: "📂 Open a folder…",
        kind: FOLDER_ENTER_KIND,
        payload: { dir: null, onPick: openPick },
      },
    ],
  };
  if (sctx?.sessionId && sctx.source === "cc") {
    spec.items.push({
      label: `🔀 Branch this session (${sctx.sessionName})`,
      kind: NEW_SPAWN_KIND,
      payload: {
        dir: sctx.sessionDir,
        resume: sctx.sessionId,
        fork: true,
      } satisfies SpawnPayload,
    });
  } else if (branchableSessions(live).length > 0) {
    spec.items.push({
      label: "🔀 Branch a session…",
      kind: NEW_PICK_LIVE_KIND,
      payload: { fork: true },
    });
  }
  spec.items.push({
    label: "▶️ Resume a conversation…",
    kind: FOLDER_ENTER_KIND,
    payload: { dir: null, onPick: resumePick },
  });
  return spec;
}

export function liveSessionsMenuSpec(
  live: SessionInfo[],
  fork: boolean,
): MenuSpec {
  return {
    title: fork ? "🔀 Branch which session?" : "Which session?",
    items: branchableSessions(live).map((s) => ({
      label: `${s.name} · ${displayPath(s.dir)}`,
      kind: NEW_SPAWN_KIND,
      payload: { dir: s.dir, resume: s.id, fork } satisfies SpawnPayload,
    })),
    back: { label: "‹ Back", kind: NEW_HOME_KIND, payload: null },
  };
}

/** Newest transcripts for `dir` (by mtime), each resumable. */
export async function transcriptsMenuSpec(
  dir: string,
  projectsDir: string = PROJECTS_DIR,
  limit: number = TRANSCRIPT_LIMIT,
): Promise<MenuSpec> {
  const proj = join(projectsDir, encodeProjectDir(dir));
  const names = await readdir(proj).catch((): string[] => []);
  const files: { id: string; path: string; mtime: number }[] = [];
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    const p = join(proj, n);
    const st = await stat(p).catch(() => null);
    if (!st?.isFile()) continue;
    files.push({
      id: basename(n, ".jsonl"),
      path: p,
      mtime: st.mtime.getTime(),
    });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const items = [];
  for (const f of files.slice(0, limit)) {
    const last = await getLastSessionMessage(f.path, 40).catch(() => null);
    const preview = last?.text ? ` · ${last.text}` : "";
    items.push({
      label: `${formatTimeAgo(f.mtime)}${preview}`.slice(0, 60),
      kind: NEW_SPAWN_KIND,
      payload: { dir, resume: f.id } satisfies SpawnPayload,
    });
  }
  return {
    title: items.length
      ? `▶️ Resume in <code>${escapeHtml(displayPath(dir))}</code>`
      : `No conversations found in <code>${escapeHtml(displayPath(dir))}</code>`,
    items,
    pageSize: 5,
  };
}

/** Show the top-level /new menu (called by handleNew when it has no args). */
export async function showNewMenu(
  ctx: Context,
  sctx?: SessionContext,
): Promise<void> {
  await showMenu(ctx, newMenuSpec(sctx, getSessions()));
}

export function registerNewMenu(
  deps: {
    spawn: typeof spawnDesktopClaudeSession;
    scan: typeof scanPortFiles;
    sessions: typeof getSessions;
    allowed: (dir: string) => boolean;
  } = {
    spawn: spawnDesktopClaudeSession,
    scan: scanPortFiles,
    sessions: getSessions,
    allowed: isPathAllowed,
  },
): void {
  registerMenuKind(NEW_HOME_KIND, async (ctx) => {
    await replaceMenu(ctx, newMenuSpec(undefined, deps.sessions()));
    await ctx.answerCallbackQuery().catch(() => {});
  });

  registerMenuKind(NEW_PICK_LIVE_KIND, async (ctx, entry) => {
    const { fork } = entry.payload as { fork: boolean };
    await replaceMenu(ctx, liveSessionsMenuSpec(deps.sessions(), fork));
    await ctx.answerCallbackQuery().catch(() => {});
  });

  registerMenuKind(NEW_PICK_TRANSCRIPT_KIND, async (ctx, entry) => {
    const { dir } = entry.payload as { dir: string };
    await replaceMenu(ctx, await transcriptsMenuSpec(dir));
    await ctx.answerCallbackQuery().catch(() => {});
  });

  registerMenuKind(NEW_SPAWN_KIND, async (ctx, entry) => {
    const { dir, resume, fork } = entry.payload as SpawnPayload;
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (chatId === undefined || userId === undefined) return;

    // Same gate as typed /new: live port files can point anywhere a Claude
    // was started by hand, and a bot-managed spawn must stay in ALLOWED_PATHS.
    if (!deps.allowed(dir)) {
      await ctx
        .answerCallbackQuery({
          text: "That folder isn't in the bot's allowed paths.",
          show_alert: true,
        })
        .catch(() => {});
      return;
    }

    if (resume && !fork) {
      const live = (await deps.scan(true)).find(
        (pf) => pf.sessionId === resume,
      );
      if (live) {
        await ctx
          .answerCallbackQuery({
            text: `Already running as ${live.sessionName ?? "a live session"} — branch it instead.`,
            show_alert: true,
          })
          .catch(() => {});
        return;
      }
    }

    const opts: SpawnOptions | undefined = resume
      ? { resumeSessionId: resume, fork: !!fork }
      : undefined;
    const what = resume
      ? fork
        ? "🔀 Branching"
        : "▶️ Resuming"
      : "🚀 Spawning";
    await ctx
      .editMessageText(
        `${what} desktop session…\n📁 <code>${escapeHtml(displayPath(dir))}</code>`,
        {
          parse_mode: "HTML",
        },
      )
      .catch(() => {});
    await ctx.answerCallbackQuery().catch(() => {});
    info("menu: new.spawn", { chatId, userId, dir, resume, fork: !!fork });
    await deps.spawn(ctx.api, chatId, dir, userId, opts);
  });
}
