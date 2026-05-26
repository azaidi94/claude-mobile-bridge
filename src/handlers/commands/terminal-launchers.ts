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

function resolveCmuxBin(): string | null {
  const onPath = Bun.which("cmux");
  if (onPath) return onPath;
  try {
    statSync(CMUX_APP_BIN);
    return CMUX_APP_BIN;
  } catch {
    return null;
  }
}

export function buildDesktopShellCommand(
  explicitPath: string,
  claudePath: string,
): string {
  if (DESKTOP_CLAUDE_COMMAND_TEMPLATE) {
    return DESKTOP_CLAUDE_COMMAND_TEMPLATE.replace(
      /\{dir\}/g,
      bashSingleQuotedPath(explicitPath),
    );
  }
  return `cd ${bashSingleQuotedPath(explicitPath)} && exec ${bashSingleQuotedPath(claudePath)} ${DESKTOP_CLAUDE_DEFAULT_ARGS}`;
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
} {
  const built = buildTerminalSpawnArgs(
    getTerminal(),
    shellCommand,
    explicitPath,
  );
  if ("error" in built) {
    return { ok: false, stderr: built.error };
  }
  const r = Bun.spawnSync(built.argv);
  const stderr = (r.stderr ?? Buffer.alloc(0)).toString().trim();
  return { ok: r.exitCode === 0, stderr };
}
