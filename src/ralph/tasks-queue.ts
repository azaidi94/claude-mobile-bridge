/**
 * Pure parser/advancer for a ralph `plans/tasks.md` checklist. No IO.
 * Items are markdown headers `## [ ] N. Title` / `## [x] N. Title`; an item's
 * block runs from its header up to the next `## ` header (or EOF).
 */

export interface TaskItem {
  id: number;
  title: string;
  done: boolean;
  dependsOn: number[];
  block: string;
}

export type QueueStatus = "ready" | "complete" | "waiting";

const HEADER_RE = /^## \[( |x)\] (\d+)\. (.*)$/;

/** Parse the full tasks.md into ordered items (by appearance). */
export function parseTasks(md: string): TaskItem[] {
  const lines = md.split("\n");
  const items: TaskItem[] = [];
  let current: { header: RegExpMatchArray; body: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const [, mark, idStr, title] = current.header;
    const block = [current.header.input, ...current.body].join("\n").trim();
    const depLine = current.body.find((l) => /^\*\*Depends on:\*\*/.test(l));
    const dependsOn =
      depLine && !/none/i.test(depLine)
        ? (depLine.match(/\d+/g) ?? []).map(Number)
        : [];
    items.push({
      id: Number(idStr),
      title: title!.trim(),
      done: mark === "x",
      dependsOn,
      block,
    });
    current = null;
  };

  for (const line of lines) {
    const m = line.match(HEADER_RE);
    if (m) {
      flush();
      current = { header: m, body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return items;
}

/** Lowest-id undone item whose every dependency is a done item. */
export function nextEligible(items: TaskItem[]): TaskItem | null {
  const doneIds = new Set(items.filter((i) => i.done).map((i) => i.id));
  const pending = items.filter((i) => !i.done).sort((a, b) => a.id - b.id);
  for (const item of pending) {
    if (item.dependsOn.every((d) => doneIds.has(d))) return item;
  }
  return null;
}

export function queueStatus(items: TaskItem[]): QueueStatus {
  if (items.every((i) => i.done)) return "complete";
  return nextEligible(items) ? "ready" : "waiting";
}

/**
 * A heading whose text opens with a checkbox-ish marker AND a number: what a
 * hand-edited task header looks like when it's ALMOST right (`## [ ] 1: T`,
 * `## [X] 1. T`, `### [] 1. T`, an indented header).
 *
 * Deliberately narrow, because a false positive aborts a queue that would have
 * run fine. A heading with no bracket is prose; a bracket with no number
 * (`### [ ] unit tests green`) is a sub-checklist inside a task body, which is
 * legal and common.
 */
const HEADERISH_RE = /^\s{0,3}#{1,6}\s*\[[ xX]?\]\s*\d/;

const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Guard against a hand-edit that parses to nothing. `queueStatus([])` is
 * vacuously "complete" (`[].every` → true), so without this the loop prints
 * "All issues resolved" and exits 0 having run no tasks — a silent no-op that
 * looks like success. Returns a human-readable problem, or null when the file
 * is trustworthy.
 */
export function queueProblem(md: string, items: TaskItem[]): string | null {
  // Fenced blocks are skipped: a task's Context routinely quotes code or the
  // tasks.md format itself, and neither is a broken header.
  let inFence = false;
  const broken = md.split("\n").filter((l) => {
    if (FENCE_RE.test(l)) {
      inFence = !inFence;
      return false;
    }
    return !inFence && HEADERISH_RE.test(l) && !HEADER_RE.test(l);
  });
  if (broken.length) {
    const shown = broken.slice(0, 3).map((l) => l.trim());
    return (
      `${broken.length} header(s) don't match \`## [ ] N. Title\`: ` +
      shown.join(" | ") +
      (broken.length > shown.length ? " …" : "")
    );
  }
  if (items.length === 0 && md.trim() !== "")
    return "no `## [ ] N. Title` items found in a non-empty file";
  return null;
}

/**
 * Return md with item `id`'s checkbox flipped to `[x]` (idempotent).
 *
 * `0*` because parseTasks normalises `01` → 1: without it a zero-padded header
 * parses fine, is served to a session, and then silently fails to flip.
 */
export function markDone(md: string, id: number): string {
  const re = new RegExp(`^(## )\\[ \\](\\s0*${id}\\. )`, "m");
  return md.replace(re, `$1[x]$2`);
}
