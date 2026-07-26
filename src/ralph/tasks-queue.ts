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

/** Return md with item `id`'s checkbox flipped to `[x]` (idempotent). */
export function markDone(md: string, id: number): string {
  const re = new RegExp(`^(## )\\[ \\](\\s${id}\\. )`, "m");
  return md.replace(re, `$1[x]$2`);
}
