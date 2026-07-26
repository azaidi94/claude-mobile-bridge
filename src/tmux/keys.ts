/**
 * The /tui inline keyboard: action names, their tmux key argv, and the callback
 * contract.
 *
 * Callback data is `tui:<action>:<launchUuid>` — 4 + ≤5 + 1 + 36 = 46 bytes,
 * inside Telegram's 64-byte limit.
 *
 * There is deliberately NO epoch/session-id field (the upstream project carries
 * one to reject stale keyboards). We re-resolve the launchUuid to its CURRENT
 * pane on every tap, which is a stronger guard: it also survives a session-id
 * change from /clear.
 */

import { InlineKeyboard } from "grammy";

/** Every action the panel can emit. `refresh`/`close` send no keys. */
export const TUI_ACTIONS = [
  "up",
  "dn",
  "lt",
  "rt",
  "ent",
  "bsp",
  "esc",
  "esc2",
  "tab",
  "btab",
  "num1",
  "num2",
  "num3",
  "num0",
  "cC",
  "cU",
  "cO",
  "cR",
  "cT",
  "refresh",
  "close",
] as const;

export type TuiAction = (typeof TUI_ACTIONS)[number];

/** action → `tmux send-keys` arguments. Empty array = issues no send-keys. */
const KEY_ARGV: Record<TuiAction, string[]> = {
  up: ["Up"],
  dn: ["Down"],
  lt: ["Left"],
  rt: ["Right"],
  ent: ["Enter"],
  bsp: ["BSpace"],
  esc: ["Escape"],
  esc2: ["Escape", "Escape"],
  tab: ["Tab"],
  btab: ["BTab"],
  num1: ["1"],
  num2: ["2"],
  num3: ["3"],
  num0: ["0"],
  cC: ["C-c"],
  cU: ["C-u"],
  cO: ["C-o"],
  cR: ["C-r"],
  cT: ["C-t"],
  refresh: [],
  close: [],
};

function isTuiAction(s: string): s is TuiAction {
  return (TUI_ACTIONS as readonly string[]).includes(s);
}

/**
 * tmux argv for an action, or `null` if unknown. Returning null (rather than a
 * passthrough) is what stops an arbitrary callback string reaching `send-keys`.
 */
export function tuiKeyArgv(action: string): string[] | null {
  return isTuiAction(action) ? [...KEY_ARGV[action]] : null;
}

/**
 * The 4-row panel:
 *   row 1  ⬆️ ⬇️ ⬅️ ➡️
 *   row 2  ↩️ ⌫ Esc Esc2 Tab ⇧Tab
 *   row 3  1 2 3 0
 *   row 4  ⌃C ⌃U ⌃O ⌃R ⌃T 🔄 Close
 */
export function buildTuiKeyboard(launchUuid: string): InlineKeyboard {
  const cb = (a: TuiAction): string => `tui:${a}:${launchUuid}`;
  const kb = new InlineKeyboard();

  kb.text("⬆️", cb("up"))
    .text("⬇️", cb("dn"))
    .text("⬅️", cb("lt"))
    .text("➡️", cb("rt"))
    .row();

  kb.text("↩️", cb("ent"))
    .text("⌫", cb("bsp"))
    .text("Esc", cb("esc"))
    .text("Esc 2", cb("esc2"))
    .text("Tab", cb("tab"))
    .text("⇧Tab", cb("btab"))
    .row();

  kb.text("1", cb("num1"))
    .text("2", cb("num2"))
    .text("3", cb("num3"))
    .text("0", cb("num0"))
    .row();

  kb.text("⌃C", cb("cC"))
    .text("⌃U", cb("cU"))
    .text("⌃O", cb("cO"))
    .text("⌃R", cb("cR"))
    .text("⌃T", cb("cT"))
    .text("🔄", cb("refresh"))
    .text("✕", cb("close"));

  return kb;
}

/** Parse `tui:<action>:<launchUuid>`. Null on any validation failure. */
export function parseTuiCallback(
  data: string,
): { action: TuiAction; launchUuid: string } | null {
  if (!data.startsWith("tui:")) return null;
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const [, action, launchUuid] = parts;
  if (!action || !launchUuid) return null;
  if (!isTuiAction(action)) return null;
  return { action, launchUuid };
}
