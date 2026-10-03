# Button menus

Telegram inline keyboards for commands that take arguments, so a phone user
never types paths or session ids. `/new` and `/claude` use them today; the
component is reusable for any other command.

## How a menu works

1. A **supplier** builds a `MenuSpec` — a title plus `MenuItem`s, each with a
   `label`, a `kind` and a `payload` (see `src/menus/menu.ts`).
2. `renderMenu` turns the spec into an `InlineKeyboard`. Every button carries
   `menu:<8-char token>`; the token resolves in the **registry**
   (`src/menus/registry.ts`) to `{ kind, payload, chatId }`. Telegram caps
   `callback_data` at 64 bytes, so payloads (paths, uuids) never leave the bot.
3. A tap arrives at `handleCallback` → `handleMenuCallback(token)`. Expired or
   foreign-chat tokens answer "Menu expired — run the command again." and do
   nothing. Paging (`‹ Prev` / `Next ›`) and `Back` are handled here.
4. Otherwise the item's `kind` is dispatched to the handler registered with
   `registerMenuKind(kind, handler)`. Handlers usually `replaceMenu` (drill
   down, editing the tapped message in place) or perform the action.

Tokens live 30 minutes and are swept lazily; a bot restart invalidates them.

## Suppliers

| Supplier       | File                          | Kinds                                               |
| -------------- | ----------------------------- | --------------------------------------------------- |
| Folder browser | `src/menus/folder-browser.ts` | `folder.enter`                                      |
| `/new`         | `src/menus/new-menu.ts`       | `new.spawn`, `new.pick-live`, `new.pick-transcript` |
| `/claude`      | `src/menus/claude-menu.ts`    | `claude.group`, `claude.cmd`, `claude.help`         |

**Folder browser.** Walks `ALLOWED_PATHS` one level at a time: a virtual
root listing, then per-folder pages (10 per page) with `✅ Open here`,
subfolders and `⬆️ Up`. Dot-dirs, `node_modules`, `__pycache__`, `dist`,
`build` are hidden. Navigation can never leave an allowed root. Callers pass
a `FolderPick { kind, extra }` describing what "Open here" should dispatch.

**`/new` menu.** `📂 Open a folder…` (plain spawn), `🔀 Branch this session`
(in a session topic: `--resume <id> --fork-session`) or `🔀 Branch a
session…` (in General: pick a live session), `▶️ Resume a conversation…`
(folder browser → newest transcripts in that folder → spawn with
`--resume <id>`). Resuming an id that is already live is refused with an
alert; branching sidesteps that by forking.

**`/claude` menu.** Groups → commands (two per row). Each entry in
`claude-command-reference.ts` declares how it takes its argument:

| `arg`            | Tap behaviour                                                      | Examples                             |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------ |
| `none` (default) | sends `/name` immediately                                          | `/clear`, `/compact`, `/usage`       |
| `options: [...]` | second-level menu of fixed choices → `/name <choice>`              | `/model`, `/permissions`, `/effort`  |
| `optional`       | "Send as is" or "Enter text…"                                      | `/code-review`, `/resume`, `/export` |
| `required`       | asks for the text; the **next message in that topic** completes it | `/btw`, `/rename`, `/goal`, `/cd`    |

Pending text (`src/menus/claude-pending.ts`) is keyed by chat+topic, expires
after 10 minutes, and `/cancel` clears it. Taps go through the same injector
and blocklist as `/claude <cmd>`; `/claude help` prints the text reference.

## Adding a supplier

```ts
import {
  registerMenuKind,
  replaceMenu,
  showMenu,
  type MenuSpec,
} from "../menus";

export const MY_KIND = "my.pick";

export function mySpec(): MenuSpec {
  return {
    title: "Pick one",
    items: [{ label: "A", kind: MY_KIND, payload: { a: 1 } }],
  };
}

export function registerMyMenu(): void {
  registerMenuKind(MY_KIND, async (ctx, entry) => {
    const { a } = entry.payload as { a: number };
    // do the thing, or replaceMenu(ctx, nextSpec) to drill down
    await ctx.answerCallbackQuery();
  });
}
```

Register it at boot next to `registerNewMenu()` in `src/index.ts`, and open it
from a command with `showMenu(ctx, mySpec())`. Keep labels short (Telegram
truncates long button text) and lists paged (`pageSize`).

Rules of thumb: never put user data in `callback_data`; always
`answerCallbackQuery` (even on refusal) so the phone's spinner stops; a
handler that spawns or sends should `editMessageText` the tapped menu into a
status line so the buttons can't be tapped twice.
