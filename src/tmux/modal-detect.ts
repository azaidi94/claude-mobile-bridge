/**
 * Is the Claude Code TUI accepting keyboard input, or is a modal blocking it?
 *
 * WHY send-and-verify rather than a regex preflight
 * -------------------------------------------------
 * Claude blocks input behind dialogs (trust, Bash permission, sensitive-file
 * edit, /usage, /mcp, /login, /config, /model, /status). When a modal is up:
 *   - `tmux send-keys -l <text>` is a NO-OP; characters never reach the buffer.
 *   - `tmux send-keys Enter` CONFIRMS THE HIGHLIGHTED ITEM — silently approving
 *     a shell command, a sensitive-file edit, or a model switch.
 *
 * A regex preflight on "Esc to cancel" works for today's dialogs and breaks the
 * day Claude ships one with new wording. So we never predict; we observe:
 *   1. Type the text with `-l` (no-op on a modal, harmless otherwise).
 *   2. Wait a render tick.
 *   3. Re-capture the pane.
 *   4. If the prompt head appears in the input bar, input was accepted → Enter.
 *   5. If it does not, a modal ate it → refuse, and tell the user.
 *
 * Ported from pavel-molyanov/telegram-ai-agent `core/tui/modal_detect.py`,
 * whose constants were verified live against Claude Code 2.1.117-2.1.119.
 *
 * This module is PURE — no subprocess, no IO. That is what makes the "Enter
 * never lands in a dialog" property testable against captured fixture panes.
 */

/** First N non-blank chars of the prompt; enough to be unique in the bar. */
const PROMPT_HEAD_CHARS = 30;

/**
 * Minimum first-line length for the first-line-only fallback (signal 3). That
 * signal is an unanchored `includes`, so below this a line like "ok" could
 * collide with unrelated pane text and fake a delivery. Signal 1 needs no floor
 * because it is anchored — see `promptVisibleInBar`.
 */
const FIRST_LINE_MIN_LEN = 10;

/** Claude prepends this indent to every input-bar continuation line. */
const CC_CONTINUATION_INDENT = "  ";

/** How far up to hunt for the `❯` bar marker. Long pastes wrap it across rows. */
const INPUT_BAR_SEARCH_LINES = 80;

/**
 * Modal footers render within ~3 lines of the pane bottom. 5 is a safe margin
 * that still excludes scrollback which merely quotes "Esc to cancel".
 */
const MODAL_FOOTER_SCAN_LINES = 5;

const INPUT_BAR_MARKER_RE = /^\s*❯\s?(.*)$/;
const BAR_SEPARATOR_RE = /^\s*─{10,}\s*$/;

/**
 * Every interactive modal advertises its dismiss keys with a CAPITAL E. Non-modal
 * states (idle, thinking, compacting) use lowercase `esc to interrupt`. That case
 * difference is the entire discriminator.
 */
const MODAL_FOOTER_TOKEN_RE =
  /\bEsc to (cancel|clear|exit|dismiss|close)\b|\bEnter to confirm\b/;

/** Claude collapses long bracketed pastes into a literal placeholder chip. */
const PASTED_PLACEHOLDER_RE =
  /\[(?:Pasted text #\d+(?: \+\d+ lines?)?|Pasted Content \d+ chars)\]/gi;

/**
 * Drop trailing blank rows. tmux nondeterministically pads a pane to its
 * configured height or trims it, depending on recent IO. Without this, a
 * last-N-lines scan counts from the physical bottom and a modal footer slips out
 * of the window — the same TUI state then yields opposite verdicts at different
 * pane heights.
 */
export function stripBlankTail(pane: string): string {
  const lines = pane.split("\n");
  while (lines.length > 0 && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines.join("\n");
}

/** Collapse every whitespace run to one space; strip the ends. */
function wsCollapse(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(" ");
}

function promptHead(prompt: string): string {
  return prompt.replace(/^\s+/, "").slice(0, PROMPT_HEAD_CHARS);
}

function countPlaceholders(s: string): number {
  return [...s.matchAll(PASTED_PLACEHOLDER_RE)].length;
}

/**
 * Gate A in isolation: does the footer carry a modal dismiss token?
 *
 * Used by the watchdog. Gate B is deliberately NOT applied here: it returns "no
 * bar" on any transient render (startup, mid-tick refresh, empty capture), and a
 * watchdog gated on it would alert constantly.
 *
 * An empty pane is NOT a modal — an unreadable pane must never raise an alert.
 */
export function isModalPresent(pane: string): boolean {
  if (!pane) return false;
  const lines = stripBlankTail(pane)
    .split("\n")
    .slice(-MODAL_FOOTER_SCAN_LINES);
  return MODAL_FOOTER_TOKEN_RE.test(lines.join("\n"));
}

/**
 * The text currently inside the input bar, or null if no bar is rendered (modal /
 * broken layout / unknown). Both gates must pass.
 *
 * Gate A — modal-footer sniff. Handles a modal that happens to render something
 * resembling an idle sandwich.
 *
 * Gate B — structural sandwich. The idle bar is `─────` / `❯ text` / `─────`.
 * Modals contain `❯` as a MENU CURSOR (`❯ 1. Yes`) but lack the frame. This is
 * what stops a prompt head matching modal menu text from faking a delivery.
 *
 * The returned text is a lossy approximation: the continuation indent is
 * stripped, which also mutates any legitimate 2-space line leads the user typed.
 * Callers needing an exact echo must use the stored prompt instead.
 */
export function claudeInputBarContent(pane: string): string | null {
  if (!pane) return null;
  const lines = stripBlankTail(pane).split("\n").slice(-INPUT_BAR_SEARCH_LINES);

  // Gate A — last few lines only. A wider window false-positives on scrollback
  // that quotes "Esc to cancel" inside documentation or code.
  const footer = lines.slice(-MODAL_FOOTER_SCAN_LINES).join("\n");
  if (MODAL_FOOTER_TOKEN_RE.test(footer)) return null;

  // Gate B — walk bottom-up to the first `❯`, require separators above AND below.
  //
  // ASSUMPTION, unenforced: a Claude modal never draws a `─{10,}` separator both
  // above AND below its `❯` menu cursor. Nothing in this function checks that; it
  // holds empirically on Claude Code 2.1.206, where every captured modal renders
  // at most one separator. A modal that sandwiched its menu row between two
  // separators AND carried a footer outside Gate A's token list (say `Enter to
  // accept` rather than `Enter to confirm`) would pass both gates and let
  // `promptVisibleInPane` report delivery with a dialog up.
  //
  // Do not assume that class is empty: `/usage` already blocks input while being
  // invisible to Gate A (no capital-E footer token). It is caught here only
  // because it happens to render no `❯` and no separator. Gate-A-blind modals
  // exist; a Gate-B-blind one is a rendering change away. If Claude ever ships a
  // framed menu, this gate needs a positive idle-bar signal, not a tweak.
  for (let idx = lines.length - 1; idx >= 0; idx--) {
    const m = INPUT_BAR_MARKER_RE.exec(lines[idx]!);
    if (!m) continue;

    const hasFrameAbove = lines
      .slice(Math.max(0, idx - 3), idx)
      .some((l) => BAR_SEPARATOR_RE.test(l));

    let hasFrameBelow = false;
    for (const cont of lines.slice(idx + 1)) {
      if (BAR_SEPARATOR_RE.test(cont)) {
        hasFrameBelow = true;
        break;
      }
      if (INPUT_BAR_MARKER_RE.test(cont)) break;
    }
    if (!hasFrameAbove || !hasFrameBelow) return null;

    const parts: string[] = [m[1] ?? ""];
    for (const cont of lines.slice(idx + 1)) {
      if (BAR_SEPARATOR_RE.test(cont)) break;
      if (INPUT_BAR_MARKER_RE.test(cont)) break;
      parts.push(
        cont.startsWith(CC_CONTINUATION_INDENT)
          ? cont.slice(CC_CONTINUATION_INDENT.length)
          : cont,
      );
    }
    return parts.join("\n");
  }
  return null;
}

function promptVisibleInBar(
  beforeBar: string | null,
  afterBar: string | null,
  prompt: string,
): boolean {
  const head = promptHead(prompt);
  if (!head || afterBar === null) return false;

  const headNorm = wsCollapse(head);
  const afterNorm = wsCollapse(afterBar);
  const beforeNorm = beforeBar ? wsCollapse(beforeBar) : "";

  // 1. ANCHORED normalized-head match, minus scrollback carry-over. The bar
  //    echoes the prompt from position 0 (`claudeInputBarContent` returns the
  //    text after `❯ `), so a delivered prompt is always a PREFIX of the bar —
  //    never a floating substring. Anchoring, not a length floor, is what stops
  //    "ok" from matching a bar reading "some unrelated ok text".
  //
  //    A floor here would be a bug, not a safety margin: it hard-wires this
  //    signal false for `/clear` (6), `/compact` (8), `/context` (8), `y`, `1`
  //    — precisely the payloads the tmux injection path exists to send. Signal 3
  //    would then reject them on its own floor and the guard would refuse them
  //    forever.
  //
  //    ASSUMPTION (empirical, Claude Code 2.1.206): the input bar echoes the
  //    prompt starting at position 0 — nothing is rendered between `❯ ` and the
  //    typed text. Verified against the captured `idle-bar-typed` fixture. If a
  //    future Claude prepends anything inline (a mode chip, an indent), this
  //    anchor stops matching and the guard REFUSES rather than sends. That fails
  //    safe and, unlike a silent floor, fails VISIBLY: the caller renders the
  //    live pane plus the key panel, so the missing submit is on screen. The one
  //    prefix Claude does render — a `[Pasted text #N]` chip — is caught by
  //    signal 2 below, not by this anchor.
  if (headNorm && afterNorm.startsWith(headNorm)) {
    return !(beforeNorm && beforeNorm.startsWith(headNorm));
  }

  // 2. A NEW paste placeholder. Claude collapses payloads above ~1500 chars, so
  //    the head never renders — but a fresh chip proves bytes reached the buffer.
  const afterPastes = countPlaceholders(afterBar);
  if (afterPastes > 0 && afterPastes > countPlaceholders(beforeBar ?? "")) {
    return true;
  }

  // 3. First-line-only fallback for a future Claude transform we do not know
  //    about. Guarded by a length floor against short-substring collisions.
  const firstLine = wsCollapse(head.split("\n", 1)[0] ?? "");
  if (firstLine.length >= FIRST_LINE_MIN_LEN && afterNorm.includes(firstLine)) {
    return !(beforeNorm && beforeNorm.includes(firstLine));
  }

  return false;
}

/**
 * True iff the prompt head PREFIXES `after`'s input bar and did not already
 * prefix `before`'s.
 *
 * The primary signal is an anchored match, not a substring scan: the bar echoes
 * what was typed starting at column 0, so anchoring is both stricter and free of
 * the length floor that would otherwise disable short prompts like `/clear`.
 *
 * Closes three false-positive classes:
 *   (a) modal overlay — `after` has no bar, so we never report delivery even if
 *       the modal body contains text matching the head. SECURITY-CRITICAL: this
 *       is what keeps Enter out of a dialog.
 *   (b) lingering scrollback — the head was already in the bar from a prior send.
 *   (c) stale paste placeholder — same chip persists across the send.
 */
export function promptVisibleInPane(
  before: string,
  after: string,
  prompt: string,
): boolean {
  return promptVisibleInBar(
    claudeInputBarContent(before),
    claudeInputBarContent(after),
    prompt,
  );
}
