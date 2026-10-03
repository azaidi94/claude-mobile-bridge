import { describe, test, expect, beforeEach, mock } from "bun:test";

const replies: { text: string; opts: unknown }[] = [];
mock.module("../handlers/commands/helpers", () => ({
  busReply: async (_ctx: unknown, text: string, opts: unknown) => {
    replies.push({ text, opts });
  },
}));

import {
  renderMenu,
  handleMenuCallback,
  registerMenuKind,
  MENU_EXPIRED_TEXT,
  PAGE_KIND,
  _resetMenuKindsForTests,
  type MenuSpec,
} from "../menus/menu";
import {
  getToken,
  putToken,
  _resetMenuRegistryForTests,
} from "../menus/registry";

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    label: `item ${i}`,
    kind: "t.pick",
    payload: i,
  }));

const buttons = (kb: {
  inline_keyboard: { text: string; callback_data?: string }[][];
}) => kb.inline_keyboard.map((row) => row.map((b) => b.text));

describe("renderMenu", () => {
  beforeEach(() => _resetMenuRegistryForTests());

  test("one row per item, no paging under the page size", () => {
    const { text, keyboard } = renderMenu({ title: "T", items: items(3) }, 1);
    expect(text).toBe("T");
    expect(buttons(keyboard as never)).toEqual([
      ["item 0"],
      ["item 1"],
      ["item 2"],
    ]);
  });

  test("every button carries a short menu token that resolves to its item", () => {
    const { keyboard } = renderMenu({ title: "T", items: items(3) }, 7);
    for (const row of (
      keyboard as never as { inline_keyboard: { callback_data: string }[][] }
    ).inline_keyboard) {
      for (const b of row) {
        expect(b.callback_data).toMatch(/^menu:[a-z0-9]{8}$/);
        expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
        const e = getToken(b.callback_data.slice(5));
        expect(e?.chatId).toBe(7);
      }
    }
  });

  test("pages at pageSize with Prev/Next and a counter in the title", () => {
    const spec: MenuSpec = { title: "T", items: items(25), pageSize: 8 };
    const p0 = renderMenu(spec, 1);
    expect(p0.text).toBe("T  (1/4)");
    expect(buttons(p0.keyboard as never)).toEqual([
      ...items(8).map((i) => [i.label]),
      ["Next ›"],
    ]);
    const p3 = renderMenu({ ...spec, page: 3 }, 1);
    expect(p3.text).toBe("T  (4/4)");
    expect(buttons(p3.keyboard as never)).toEqual([["item 24"], ["‹ Prev"]]);
    const p1 = renderMenu({ ...spec, page: 1 }, 1);
    expect(buttons(p1.keyboard as never).at(-1)).toEqual(["‹ Prev", "Next ›"]);
  });

  test("back renders as the last row; two columns pack pairs", () => {
    const { keyboard } = renderMenu(
      {
        title: "T",
        items: items(3),
        columns: 2,
        back: { label: "⬆️ Up", kind: "t.up", payload: null },
      },
      1,
    );
    expect(buttons(keyboard as never)).toEqual([
      ["item 0", "item 1"],
      ["item 2"],
      ["⬆️ Up"],
    ]);
  });
});

describe("handleMenuCallback", () => {
  const answers: unknown[] = [];
  const edits: { text: string; opts: unknown }[] = [];
  const ctx = {
    chat: { id: 1 },
    answerCallbackQuery: async (o?: unknown) => {
      answers.push(o ?? {});
    },
    editMessageText: async (text: string, opts: unknown) => {
      edits.push({ text, opts });
    },
  };

  beforeEach(() => {
    _resetMenuRegistryForTests();
    _resetMenuKindsForTests();
    answers.length = 0;
    edits.length = 0;
    replies.length = 0;
  });

  test("expired token answers and does nothing", async () => {
    await handleMenuCallback(ctx as never, "zzzzzzzz");
    expect(answers).toEqual([{ text: MENU_EXPIRED_TEXT }]);
    expect(edits).toEqual([]);
  });

  test("token from another chat is treated as expired", async () => {
    const t = putToken({ kind: "t.pick", payload: 1, chatId: 999 });
    await handleMenuCallback(ctx as never, t);
    expect(answers).toEqual([{ text: MENU_EXPIRED_TEXT }]);
  });

  test("page tokens re-render the message in place", async () => {
    const spec: MenuSpec = { title: "T", items: items(20), pageSize: 8 };
    const t = putToken({
      kind: PAGE_KIND,
      payload: { spec, page: 2 },
      chatId: 1,
    });
    await handleMenuCallback(ctx as never, t);
    expect(edits[0]?.text).toBe("T  (3/3)");
    expect(answers).toEqual([{}]);
  });

  test("dispatches to the registered kind handler with the entry", async () => {
    const seen: unknown[] = [];
    registerMenuKind("t.pick", async (_c, e) => {
      seen.push(e.payload);
    });
    const t = putToken({ kind: "t.pick", payload: { dir: "/p" }, chatId: 1 });
    await handleMenuCallback(ctx as never, t);
    expect(seen).toEqual([{ dir: "/p" }]);
  });

  test("unknown kind answers with an error", async () => {
    const t = putToken({ kind: "nope", payload: null, chatId: 1 });
    await handleMenuCallback(ctx as never, t);
    expect(answers).toEqual([{ text: "Unknown menu action." }]);
  });
});
