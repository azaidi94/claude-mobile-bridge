/**
 * /execute command — launch or stop configured shell scripts.
 *
 * Commands are read from EXECUTE_COMMANDS_FILE (JSON array of {name, script}).
 * Process state is tracked in memory; PID liveness is verified on each render.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { escapeHtml } from "../formatting";
import { info, warn } from "../logger";

export interface ExecuteCommand {
  name: string;
  script: string;
}

interface RunningProcess {
  pid: number;
  name: string;
}

// In-memory PID tracking; resets on bot restart
const runningProcesses = new Map<number, RunningProcess>();

function getCommandsFile(): string {
  return (
    process.env.EXECUTE_COMMANDS_FILE ||
    resolve(import.meta.dir, "../../execute-commands.json")
  );
}

export function getExecuteCommands(): ExecuteCommand[] {
  const file = getCommandsFile();
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is ExecuteCommand =>
        typeof e?.name === "string" && typeof e?.script === "string",
    );
  } catch {
    return [];
  }
}

export function isProcessRunning(idx: number): boolean {
  const proc = runningProcesses.get(idx);
  if (!proc) return false;
  try {
    process.kill(proc.pid, 0); // signal 0 = liveness check
    return true;
  } catch {
    runningProcesses.delete(idx); // process died on its own
    return false;
  }
}

export function startProcess(idx: number, cmd: ExecuteCommand): boolean {
  if (isProcessRunning(idx)) return false;
  const child = spawn("bash", [cmd.script], {
    detached: true,
    stdio: "ignore",
  });
  if (!child.pid) {
    warn("execute: spawn returned no PID", { name: cmd.name });
    return false;
  }
  child.unref(); // let it outlive this process
  runningProcesses.set(idx, { pid: child.pid, name: cmd.name });
  info("execute: started", {
    name: cmd.name,
    pid: child.pid,
    script: cmd.script,
  });
  return true;
}

export function stopProcess(idx: number): boolean {
  const proc = runningProcesses.get(idx);
  if (!proc) return false;
  try {
    process.kill(proc.pid, "SIGTERM");
    info("execute: stopped", { name: proc.name, pid: proc.pid });
  } catch {
    // Already dead — that's fine
  }
  runningProcesses.delete(idx);
  return true;
}

export function buildExecuteMenu(commands: ExecuteCommand[]): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const kb = new InlineKeyboard();
  const lines: string[] = ["<b>Execute commands</b>\n"];

  commands.forEach((cmd, idx) => {
    const running = isProcessRunning(idx);
    lines.push(`${running ? "🟢" : "⚫"} <b>${escapeHtml(cmd.name)}</b>`);
    const label = running ? `■ Stop ${cmd.name}` : `▶ Start ${cmd.name}`;
    const action = running ? `execute:stop:${idx}` : `execute:start:${idx}`;
    kb.text(label, action).row();
  });

  return { text: lines.join("\n"), keyboard: kb };
}

export async function handleExecute(ctx: Context): Promise<void> {
  const commands = getExecuteCommands();

  if (commands.length === 0) {
    const file = getCommandsFile();
    await ctx.reply(
      "No execute commands configured.\n\n" +
        `Create <code>${escapeHtml(file)}</code>:\n` +
        `<pre>[{"name": "VPN", "script": "/path/to/script.sh"}]</pre>`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const { text, keyboard } = buildExecuteMenu(commands);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}
