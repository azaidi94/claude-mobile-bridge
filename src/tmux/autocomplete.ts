/**
 * Claude Code opens a command-autocomplete popup while a slash command is
 * being typed. When the typed name is a prefix of more than one entry (e.g.
 * `/branch` vs a skill ending in "…-branch"), the popup stays open and the
 * first Enter only selects the highlighted entry — the command is still
 * sitting in the input bar. This detects that state so the injector can
 * press Enter once more.
 */

const escapeRe = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when some pane line is the prompt head followed only by `text`. */
export function inputStillHolds(pane: string, text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const re = new RegExp(`^\\s*[❯>]\\s*${escapeRe(t)}\\s*$`, "m");
  return re.test(pane);
}
