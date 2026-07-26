/**
 * Thin CLI wrapper over tasks-queue, invoked by scripts/ralph/afk_tasks_md.sh:
 *   bun src/ralph/tasks-queue-cli.ts next plans/tasks.md   → JSON status/item
 *   bun src/ralph/tasks-queue-cli.ts done plans/tasks.md 2 → flip item 2 to [x]
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import {
  parseTasks,
  nextEligible,
  queueStatus,
  queueProblem,
  markDone,
  type QueueStatus,
} from "./tasks-queue";

/**
 * What `next` puts on the wire. A superset of QueueStatus: "malformed" is a
 * CLI-level verdict (it needs the raw file, not just the parsed items), and
 * afk_tasks_md.sh branches on every member — keep the two in step.
 */
type NextStatus = QueueStatus | "malformed";

export function runCli(argv: string[]): string {
  const [cmd, file, idArg] = argv;
  if (!cmd || !file) throw new Error("usage: <next|done> <file> [id]");

  if (cmd === "next") {
    const emit = (status: NextStatus, rest: object = {}) =>
      JSON.stringify({ status, ...rest });
    if (!existsSync(file)) return emit("complete");
    const md = readFileSync(file, "utf8");
    const items = parseTasks(md);
    // Before status: an unparseable file reads as "complete" otherwise.
    const problem = queueProblem(md, items);
    if (problem) return emit("malformed", { error: problem });
    const status = queueStatus(items);
    if (status !== "ready") return emit(status);
    const item = nextEligible(items)!;
    return emit("ready", {
      id: item.id,
      title: item.title,
      block: item.block,
    });
  }

  if (cmd === "done") {
    const id = Number(idArg);
    if (!Number.isInteger(id)) throw new Error(`bad id: ${idArg}`);
    const before = readFileSync(file, "utf8");
    const after = markDone(before, id);
    // Unchanged is fine only when the item was ALREADY `[x]` (markDone is
    // idempotent). Unchanged because no such item exists means the loop would
    // re-serve the same task every iteration — fail loudly instead.
    if (
      after === before &&
      !parseTasks(before).some((i) => i.id === id && i.done)
    )
      throw new Error(`no item ${id} to mark done in ${file}`);
    writeFileSync(file, after);
    return "";
  }

  throw new Error(`unknown command: ${cmd}`);
}

if (import.meta.main) {
  const out = runCli(process.argv.slice(2));
  if (out) process.stdout.write(out + "\n");
}
