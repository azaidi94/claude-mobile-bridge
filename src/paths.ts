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
