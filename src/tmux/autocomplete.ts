/**
 * Claude Code opens a command-autocomplete popup while a slash command is
 * being typed. When the typed name is a prefix of more than one entry (e.g.
 * `/branch` vs a skill ending in "…-branch"), the popup stays open and the
 * first Enter only selects the highlighted entry — the command is still
 * sitting in the input bar. This detects that state so the injector can
 * press Enter once more.
 *
 * Structural, not textual: Claude echoes every submitted prompt into the
 * transcript as `❯ /cmd`, so a free regex over the pane would fire on a
 * successful submit too. Only the input bar (the `───` / `❯ …` / `───`
 * sandwich at the bottom) counts.
 */

import { claudeInputBarContent } from "./modal-detect";

/** True when the input bar holds exactly `text` (trimmed). */
export function inputStillHolds(pane: string, text: string): boolean {
  const t = text.trim();
  if (!t || !pane) return false;
  const bar = claudeInputBarContent(pane);
  return bar !== null && bar.trim() === t;
}
