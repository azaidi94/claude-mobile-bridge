/**
 * Per-terminal-app launcher dispatch for desktop Claude spawn.
 *
 * `buildTerminalSpawnArgs` is pure (exported for unit tests).
 * `openMacOSTerminalWithCommand` wraps it with `Bun.spawnSync` for the live
 * call site. `buildDesktopShellCommand` assembles the shell command the
 * terminal window will run.
 */

import { statSync } from "fs";
import {
  DESKTOP_CLAUDE_DEFAULT_ARGS,
  DESKTOP_CLAUDE_COMMAND_TEMPLATE,
  type TerminalApp,
} from "../../config";
import { getTerminal } from "../../settings";
import { bashSingleQuotedPath, escapeAppleScriptDoubleQuoted } from "./helpers";

/** Fallback path for the cmux CLI when it isn't on PATH (installed via cmux.app). */
const CMUX_APP_BIN = "/Applications/cmux.app/Contents/MacOS/cmux";

export function resolveCmuxBin(): string | null {
  const onPath = Bun.which("cmux");
  if (onPath) return onPath;
  try {
    statSync(CMUX_APP_BIN);
    return CMUX_APP_BIN;
  } catch {
    return null;
  }
}

/** Options that change which conversation a desktop spawn starts on. */
export interface SpawnOptions {
  /** Resume this transcript (`claude --resume <id>`). */
  resumeSessionId?: string;
  /** With `resumeSessionId`: fork into a NEW session id (`--fork-session`). */
  fork?: boolean;
}

/** Extra Claude CLI args implied by `opts` — `[]` when there are none. */
export function spawnExtraArgs(opts?: SpawnOptions): string[] {
  if (!opts?.resumeSessionId) return [];
  const args = ["--resume", opts.resumeSessionId];
  if (opts.fork) args.push("--fork-session");
  return args;
}

export function buildDesktopShellCommand(
  explicitPath: string,
  claudePath: string,
  opts?: SpawnOptions,
  cfg: { template: string; defaultArgs: string } = {
    template: DESKTOP_CLAUDE_COMMAND_TEMPLATE,
    defaultArgs: DESKTOP_CLAUDE_DEFAULT_ARGS,
  },
): string {
  const extras = spawnExtraArgs(opts);
  if (cfg.template) {
    const cmd = cfg.template.replace(
      /\{dir\}/g,
      bashSingleQuotedPath(explicitPath),
    );
    if (extras.length === 0) return cmd;
    // The launch script reads CLAUDE_RELAY_ARGS and forwards it through the
    // tmux outer phase; it REPLACES the script's defaults, so include them.
    // Session ids are UUIDs (validated by the caller) — safe inside quotes.
    // `export …;` (not a `VAR=… cmd` prefix) so a compound template such as
    // `cd {dir} && …/claude-relay-launch.sh` still sees the variable.
    const relayArgs = [cfg.defaultArgs, ...extras].join(" ");
    return `export CLAUDE_RELAY_ARGS=${bashSingleQuotedPath(relayArgs)}; ${cmd}`;
  }
  const tail = [cfg.defaultArgs, ...extras].filter(Boolean).join(" ");
  return `cd ${bashSingleQuotedPath(explicitPath)} && exec ${bashSingleQuotedPath(claudePath)} ${tail}`;
}

/**
 * Pure dispatch from a `TerminalApp` to the argv needed to spawn a new
 * terminal window running `shellCommand` in `explicitPath`. Exported for
 * unit tests — prod code should call `openMacOSTerminalWithCommand`.
 */
export function buildTerminalSpawnArgs(
  terminalApp: TerminalApp,
  shellCommand: string,
  explicitPath: string,
): { argv: string[] } | { error: string } {
  switch (terminalApp) {
    case "ghostty":
      return {
        argv: [
          "open",
          "-na",
          "Ghostty.app",
          "--args",
          "-e",
          "/bin/sh",
          "-c",
          shellCommand,
        ],
      };
    case "cmux": {
      const cmuxBin = resolveCmuxBin();
      if (!cmuxBin) {
        return {
          error: "cmux CLI not found. Install cmux.app from https://cmux.dev",
        };
      }
      return {
        argv: [
          cmuxBin,
          "new-workspace",
          "--cwd",
          explicitPath,
          "--command",
          shellCommand,
        ],
      };
    }
    case "iterm2": {
      const esc = escapeAppleScriptDoubleQuoted(shellCommand);
      const script = [
        `tell application "iTerm2"`,
        `  activate`,
        `  tell (create window with default profile)`,
        `    tell current session of current tab of current window`,
        `      write text "${esc}"`,
        `    end tell`,
        `  end tell`,
        `end tell`,
      ].join("\n");
      return { argv: ["osascript", "-e", script] };
    }
    case "terminal":
      return {
        argv: [
          "osascript",
          "-e",
          `tell application "Terminal" to do script "${escapeAppleScriptDoubleQuoted(shellCommand)}"`,
        ],
      };
    case "cursor":
    case "tmux":
      // Detect-only: `getTerminal()` never yields these, so unreachable in prod
      // — the bot can't spawn a session into a Cursor window, and "tmux" only
      // labels an inject route. Present for switch exhaustiveness.
      return {
        error: `${terminalApp} can't be used as a launch target for new sessions.`,
      };
  }
}

/**
 * Open a desktop terminal with a shell command (macOS). Wraps
 * `buildTerminalSpawnArgs` + `Bun.spawnSync` for the live call site.
 */
export function openMacOSTerminalWithCommand(
  shellCommand: string,
  explicitPath: string,
): {
  ok: boolean;
  stderr: string;
  /** stdout of the launcher — for cmux this carries the new `workspace:N` ref. */
  stdout: string;
} {
  const built = buildTerminalSpawnArgs(
    getTerminal(),
    shellCommand,
    explicitPath,
  );
  if ("error" in built) {
    return { ok: false, stderr: built.error, stdout: "" };
  }
  const r = Bun.spawnSync(built.argv);
  const stderr = (r.stderr ?? Buffer.alloc(0)).toString().trim();
  const stdout = (r.stdout ?? Buffer.alloc(0)).toString().trim();
  return { ok: r.exitCode === 0, stderr, stdout };
}
