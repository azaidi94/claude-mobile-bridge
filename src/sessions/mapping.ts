// Scaffolding for session-identity consumers (e.g. /sessions command, sync reconciler).
// Populated by: relay (sessionId) → watcher (sessionName) → topic-manager (topicId/topicName).
import type { PortFileData } from "../relay/discovery";

export interface SessionMapping {
  /** PID of the desktop Claude process (ppid of the relay). */
  claudePid: number | undefined;
  /** PID of the relay MCP server process. */
  relayPid: number;
  /** TCP port the relay server is listening on. */
  relayPort: number;
  /** Claude session UUID (discovered by relay via JSONL birthtime). */
  sessionId: string;
  /** Human-friendly session name assigned by the bot watcher. */
  sessionName: string;
  /** Telegram message_thread_id — absent for DM setups. */
  topicId?: number;
  /** Telegram forum topic name — absent for DM setups. */
  topicName?: string;
  /** Working directory of the Claude session. */
  cwd: string;
}

/**
 * Convert a port file into a fully-resolved SessionMapping.
 *
 * Returns null when the port file has not yet been fully populated
 * (sessionId or sessionName still missing — relay/watcher still catching up).
 * Callers should re-scan port files and retry after a short delay.
 */
export function resolveSessionMapping(pf: PortFileData): SessionMapping | null {
  if (!pf.sessionId || !pf.sessionName) return null;

  return {
    claudePid: pf.ppid,
    relayPid: pf.pid,
    relayPort: pf.port,
    sessionId: pf.sessionId,
    sessionName: pf.sessionName,
    topicId: pf.topicId,
    topicName: pf.topicName,
    cwd: pf.cwd,
  };
}
