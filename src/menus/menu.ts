/**
 * Reusable paged inline-keyboard menu.
 *
 * A supplier describes a `MenuSpec` (title + items); `renderMenu` turns it
 * into text + keyboard whose buttons carry `menu:<token>`; the callback
 * router resolves the token and dispatches on the item's `kind` to a handler
 * registered with `registerMenuKind`. Paging ("‹ Prev" / "Next ›") and Back
 * are handled here so suppliers only list choices.
 */

import { InlineKeyboard, type Context } from "grammy";
import { busReply } from "../handlers/commands/helpers";
import { warn } from "../logger";
import { getToken, putToken, type MenuEntry } from "./registry";

export interface MenuItem {
  label: string;
  kind: string;
  payload: unknown;
}

export interface MenuSpec {
  title: string;
  items: MenuItem[];
  page?: number;
  pageSize?: number;
  /** Rendered as the last row (e.g. "⬆️ Up" or "‹ Back"). */
  back?: MenuItem;
  columns?: 1 | 2;
}

export const DEFAULT_PAGE_SIZE = 8;
export const PAGE_KIND = "menu.page";
export const MENU_EXPIRED_TEXT = "Menu expired — run the command again.";

export type MenuHandler = (ctx: Context, entry: MenuEntry) => Promise<void>;

const handlers = new Map<string, MenuHandler>();

export function registerMenuKind(kind: string, handler: MenuHandler): void {
  handlers.set(kind, handler);
}

export function _resetMenuKindsForTests(): void {
  handlers.clear();
}

export function renderMenu(
  spec: MenuSpec,
  chatId: number,
): { text: string; keyboard: InlineKeyboard } {
  const pageSize = spec.pageSize ?? DEFAULT_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(spec.items.length / pageSize));
  const page = Math.min(Math.max(spec.page ?? 0, 0), pages - 1);
  const slice = spec.items.slice(page * pageSize, (page + 1) * pageSize);
  const columns = spec.columns ?? 1;

  type Btn = { text: string; callback_data: string };
  const rows: Btn[][] = [];
  const btn = (item: MenuItem): Btn => ({
    text: item.label,
    callback_data: `menu:${putToken({ kind: item.kind, payload: item.payload, chatId })}`,
  });

  let row: Btn[] = [];
  for (const item of slice) {
    row.push(btn(item));
    if (row.length === columns) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);

  if (pages > 1) {
    const nav: Btn[] = [];
    if (page > 0) {
      nav.push(
        btn({
          label: "‹ Prev",
          kind: PAGE_KIND,
          payload: { spec, page: page - 1 },
        }),
      );
    }
    if (page < pages - 1) {
      nav.push(
        btn({
          label: "Next ›",
          kind: PAGE_KIND,
          payload: { spec, page: page + 1 },
        }),
      );
    }
    rows.push(nav);
  }
  if (spec.back) rows.push([btn(spec.back)]);

  const kb = new InlineKeyboard(rows);

  const text = pages > 1 ? `${spec.title}  (${page + 1}/${pages})` : spec.title;
  return { text, keyboard: kb };
}

export async function showMenu(ctx: Context, spec: MenuSpec): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const { text, keyboard } = renderMenu(spec, chatId);
  await busReply(ctx, text, { format: "html", replyMarkup: keyboard });
}

/** Re-render the tapped message in place (paging, drilling into a folder…). */
export async function replaceMenu(ctx: Context, spec: MenuSpec): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const { text, keyboard } = renderMenu(spec, chatId);
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } catch (e) {
    // "message is not modified" and friends — fall back to a fresh message.
    if (!/not modified/i.test(String(e))) {
      await busReply(ctx, text, { format: "html", replyMarkup: keyboard });
    }
  }
}

/** Entry point from the callback router: `data` is the part after "menu:". */
export async function handleMenuCallback(
  ctx: Context,
  token: string,
): Promise<void> {
  const entry = getToken(token);
  const chatId = ctx.chat?.id;
  if (!entry || entry.chatId !== chatId) {
    await ctx.answerCallbackQuery({ text: MENU_EXPIRED_TEXT }).catch(() => {});
    return;
  }
  if (entry.kind === PAGE_KIND) {
    const { spec, page } = entry.payload as { spec: MenuSpec; page: number };
    await replaceMenu(ctx, { ...spec, page });
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }
  const handler = handlers.get(entry.kind);
  if (!handler) {
    warn("menu: no handler for kind", { kind: entry.kind });
    await ctx
      .answerCallbackQuery({ text: "Unknown menu action." })
      .catch(() => {});
    return;
  }
  await handler(ctx, entry);
}
