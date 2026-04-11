/**
 * /execute command — launch or stop configured shell scripts.
 *
 * Commands are read from EXECUTE_COMMANDS_FILE (JSON array of {name, script}).
 * Process state is tracked in memory; PID liveness is verified on each render.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { readFileSync, statSync } from "fs";
import { resolve } from "path";
import { escapeHtml } from "../formatting";
import { info, warn } from "../logger";
import { isAuthorized } from "../security";
import { ALLOWED_USERS } from "../config";
import { isProcessAlive } from "../relay/discovery";

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

// Cache parsed commands by file mtime — handleExecute and every callback
// refresh would otherwise re-read+re-parse the JSON on each invocation.
let cached: {
  mtimeMs: number;
  path: string;
  commands: ExecuteCommand[];
} | null = null;

export function getExecuteCommands(): ExecuteCommand[] {
  const file = getCommandsFile();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    cached = null;
    return [];
  }
  if (cached && cached.path === file && cached.mtimeMs === mtimeMs) {
    return cached.commands;
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    const commands = Array.isArray(raw)
      ? raw.filter(
          (e): e is ExecuteCommand =>
            typeof e?.name === "string" && typeof e?.script === "string",
        )
      : [];
    cached = { mtimeMs, path: file, commands };
    return commands;
  } catch {
    cached = { mtimeMs, path: file, commands: [] };
    return [];
  }
}

export function isProcessRunning(idx: number): boolean {
  const proc = runningProcesses.get(idx);
  if (!proc) return false;
  if (isProcessAlive(proc.pid)) return true;
  runningProcesses.delete(idx);
  return false;
}

export function startProcess(idx: number, cmd: ExecuteCommand): boolean {
  if (isProcessRunning(idx)) return false;
  const child = Bun.spawn(["bash", cmd.script], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const pid = child.pid;
  if (!pid) {
    warn("execute: spawn returned no PID", { name: cmd.name });
    return false;
  }
  child.unref();
  runningProcesses.set(idx, { pid, name: cmd.name });
  info("execute: started", { name: cmd.name, pid, script: cmd.script });
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
  // /execute lists configured shell scripts and starts/stops them from
  // callback buttons. The callback path is already auth-gated at
  // callback.ts:65, but rendering the menu leaks command names and script
  // existence to unauthorized users — guard here too.
  if (!isAuthorized(ctx.from?.id, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const commands = getExecuteCommands();

  if (commands.length === 0) {
    const file = getCommandsFile();
    await ctx.reply(
      "No execute commands configured.\n\n" +
        `Copy <code>execute-commands.example.json</code> → <code>${escapeHtml(file)}</code> and edit:\n` +
        `<pre>[{"name": "VPN", "script": "/path/to/script.sh"}]</pre>`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const { text, keyboard } = buildExecuteMenu(commands);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}
