/**
 * `/claude` button menu: Claude Code's own slash commands as tappable
 * buttons, with a second level for commands that take a fixed choice
 * (`/model`, `/permissions`). A tap types the command into the live session
 * exactly like `/claude <cmd>` does, through the same injector and blocklist.
 */

import type { Context } from "grammy";
import type { SessionContext } from "../sessions/context";
import {
  CLAUDE_COMMANDS,
  CLAUDE_COMMAND_REFERENCE,
  type CommandGroup,
} from "../handlers/commands/claude-command-reference";
import {
  injectSlashCommand,
  CLAUDE_COMMAND_BLOCKLIST,
} from "../handlers/commands/inject";
import { busReply } from "../handlers/commands/helpers";
import { registerMenuKind, replaceMenu, showMenu, type MenuSpec } from "./menu";

export const CLAUDE_CMD_KIND = "claude.cmd";
export const CLAUDE_HELP_KIND = "claude.help";
export const CLAUDE_GROUP_KIND = "claude.group";

export interface ClaudeCmdPayload {
  name: string; // without the leading slash
  arg?: string;
}

const strip = (n: string): string => n.replace(/^\/+/, "");

function visible(groups: readonly CommandGroup[]): readonly CommandGroup[] {
  return groups
    .map((g) => ({
      ...g,
      commands: g.commands.filter(
        (c) => !CLAUDE_COMMAND_BLOCKLIST.has(strip(c.name).toLowerCase()),
      ),
    }))
    .filter((g) => g.commands.length > 0);
}

/** Top level: one button per group, plus the text reference. */
export function claudeMenuSpec(
  groups: readonly CommandGroup[] = CLAUDE_COMMANDS,
): MenuSpec {
  return {
    title: "🤖 Claude Code commands",
    items: [
      ...visible(groups).map((g, i) => ({
        label: g.title,
        kind: CLAUDE_GROUP_KIND,
        payload: { index: i },
      })),
      {
        label: "📖 Full reference (text)",
        kind: CLAUDE_HELP_KIND,
        payload: null,
      },
    ],
  };
}

/** Second level: the commands of one group, two per row. */
export function claudeGroupMenuSpec(
  index: number,
  groups: readonly CommandGroup[] = CLAUDE_COMMANDS,
): MenuSpec {
  const g = visible(groups)[index];
  if (!g) return claudeMenuSpec(groups);
  return {
    title: `🤖 ${g.title}`,
    items: g.commands.map((c) => ({
      label: c.name,
      kind: CLAUDE_CMD_KIND,
      payload: { name: strip(c.name) } satisfies ClaudeCmdPayload,
    })),
    columns: 2,
    pageSize: 12,
    back: { label: "‹ Back", kind: CLAUDE_GROUP_KIND, payload: { index: -1 } },
  };
}

/** Third level: fixed options for one command (e.g. /model). */
export function claudeOptionsMenuSpec(
  name: string,
  options: readonly string[],
): MenuSpec {
  return {
    title: `/${strip(name)} …`,
    items: options.map((o) => ({
      label: o,
      kind: CLAUDE_CMD_KIND,
      payload: { name: strip(name), arg: o } satisfies ClaudeCmdPayload,
    })),
    back: { label: "‹ Back", kind: CLAUDE_GROUP_KIND, payload: { index: -1 } },
  };
}

export function optionsFor(
  name: string,
  groups: readonly CommandGroup[] = CLAUDE_COMMANDS,
): readonly string[] | undefined {
  for (const g of groups) {
    const hit = g.commands.find((c) => strip(c.name) === strip(name));
    if (hit?.options?.length) return hit.options;
  }
  return undefined;
}

export async function showClaudeMenu(
  ctx: Context,
  _sctx?: SessionContext,
): Promise<void> {
  await showMenu(ctx, claudeMenuSpec());
}

/**
 * Resolve the tapped topic's session. Imported lazily: the session-context
 * module drags in the watcher/relay stack, which inject.ts (our importer)
 * deliberately keeps out of its static graph.
 */
async function resolveSctxLazily(
  ctx: Context,
): Promise<SessionContext | undefined> {
  const { resolveSessionContext } = await import("../sessions/context");
  return resolveSessionContext(ctx);
}

export function registerClaudeMenu(
  deps: {
    inject: typeof injectSlashCommand;
    resolveSctx: (
      ctx: Context,
    ) => SessionContext | undefined | Promise<SessionContext | undefined>;
    groups: readonly CommandGroup[];
  } = {
    inject: injectSlashCommand,
    resolveSctx: resolveSctxLazily,
    groups: CLAUDE_COMMANDS,
  },
): void {
  registerMenuKind(CLAUDE_HELP_KIND, async (ctx) => {
    await busReply(ctx, CLAUDE_COMMAND_REFERENCE, "html");
    await ctx.answerCallbackQuery().catch(() => {});
  });

  registerMenuKind(CLAUDE_GROUP_KIND, async (ctx, entry) => {
    const { index } = entry.payload as { index: number };
    await replaceMenu(
      ctx,
      index < 0
        ? claudeMenuSpec(deps.groups)
        : claudeGroupMenuSpec(index, deps.groups),
    );
    await ctx.answerCallbackQuery().catch(() => {});
  });

  registerMenuKind(CLAUDE_CMD_KIND, async (ctx, entry) => {
    const { name: raw, arg } = entry.payload as ClaudeCmdPayload;
    const name = strip(String(raw)).split(/\s+/)[0]!.toLowerCase();
    if (!name || CLAUDE_COMMAND_BLOCKLIST.has(name)) {
      await ctx
        .answerCallbackQuery({
          text: `/${name || "?"} is blocked — use /kill or /stop instead.`,
        })
        .catch(() => {});
      return;
    }
    const opts = optionsFor(name, deps.groups);
    if (opts && !arg) {
      await replaceMenu(ctx, claudeOptionsMenuSpec(name, opts));
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    const sctx = await deps.resolveSctx(ctx);
    if (!sctx) {
      await ctx
        .answerCallbackQuery({
          text: "Use /claude inside a Claude session topic.",
          show_alert: true,
        })
        .catch(() => {});
      return;
    }
    const slash = arg ? `/${name} ${arg}` : `/${name}`;
    await ctx.answerCallbackQuery().catch(() => {});
    await deps.inject(ctx, sctx, slash, `➡️ Sent ${slash}.`);
  });
}
