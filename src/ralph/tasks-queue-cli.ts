/**
 * Thin CLI wrapper over tasks-queue, invoked by scripts/ralph/afk_tasks_md.sh:
 *   bun src/ralph/tasks-queue-cli.ts next plans/tasks.md   → JSON status/item
 *   bun src/ralph/tasks-queue-cli.ts done plans/tasks.md 2 → flip item 2 to [x]
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { parseTasks, nextEligible, queueStatus, markDone } from "./tasks-queue";

export function runCli(argv: string[]): string {
  const [cmd, file, idArg] = argv;
  if (!cmd || !file) throw new Error("usage: <next|done> <file> [id]");

  if (cmd === "next") {
    if (!existsSync(file)) return JSON.stringify({ status: "complete" });
    const items = parseTasks(readFileSync(file, "utf8"));
    const status = queueStatus(items);
    if (status !== "ready") return JSON.stringify({ status });
    const item = nextEligible(items)!;
    return JSON.stringify({
      status: "ready",
      id: item.id,
      title: item.title,
      block: item.block,
    });
  }

  if (cmd === "done") {
    const id = Number(idArg);
    if (!Number.isInteger(id)) throw new Error(`bad id: ${idArg}`);
    writeFileSync(file, markDone(readFileSync(file, "utf8"), id));
    return "";
  }

  throw new Error(`unknown command: ${cmd}`);
}

if (import.meta.main) {
  const out = runCli(process.argv.slice(2));
  if (out) process.stdout.write(out + "\n");
}
