/**
 * Persistent state and log directories.
 *
 * Kept side-effect-free so the channel-relay MCP server (which runs in a
 * separate process inside a Claude session and cannot import the
 * env-mutating `config.ts`) can share the same paths.
 */

import { homedir } from "os";
import { join } from "path";

export const STATE_DIR =
  process.env.CLAUDE_TELEGRAM_STATE_DIR ??
  join(homedir(), ".claude-mobile-bridge");

export const LOG_DIR =
  process.env.CLAUDE_TELEGRAM_LOG_DIR ??
  (process.platform === "darwin"
    ? join(homedir(), "Library", "Logs", "claude-mobile-bridge")
    : join(STATE_DIR, "logs"));

/**
 * Convert a working directory to its `~/.claude/projects/<encoded>` path.
 *
 * Claude Code encodes the cwd by replacing every non-alphanumeric character
 * with a dash — not just slashes. A project path like `…/kx_repo/kinetix-agents`
 * lands on disk as `…-kx-repo-kinetix-agents`, so a slash-only encoder points
 * at a directory that never exists for any path containing `_` or `.`, and
 * sessionId discovery/backfill silently find nothing.
 *
 * Shared by the bot (backfill) and the channel-relay MCP server (sessionId
 * self-discovery) so both encode identically.
 */
export function claudeProjectDir(workingDir: string): string {
  return join(
    homedir(),
    ".claude",
    "projects",
    workingDir.replace(/[^a-zA-Z0-9]/g, "-"),
  );
}

/**
 * Extract the relay PID from a port file name like
 * `channel-relay-<dirHash>-<pid>.json`. Returns `null` for non-matching names.
 */
export function parseRelayPortFilePid(filename: string): number | null {
  if (!filename.startsWith("channel-relay-") || !filename.endsWith(".json")) {
    return null;
  }
  const pidPart = filename.slice(0, -5).split("-").pop();
  if (!pidPart) return null;
  const pid = parseInt(pidPart, 10);
  return Number.isFinite(pid) ? pid : null;
}
