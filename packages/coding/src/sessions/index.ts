/**
 * Session management module exports.
 */

export type { SessionInfo, SessionRegistry, SessionListItem } from "./types";

export {
  loadRegistry,
  saveRegistry,
  registerSession,
  unregisterSession,
  getActiveSession,
  setActiveSession,
  updateSessionActivity,
  updateSessionId,
  generateName,
  listSessions,
  cleanupDeadSessions,
  cleanupStaleSessions,
  getSession,
  sessionFileExists,
} from "./registry";

export {
  discoverDesktopSessions,
  discoverAndRegister,
  encodeProjectPath,
  decodeProjectPath,
} from "./discovery";
