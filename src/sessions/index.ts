/**
 * Session management module exports.
 */

export type { SessionInfo } from "./types";

export {
  startWatcher,
  stopWatcher,
  forceRefresh,
  getSessions,
  getActiveSession,
  setActiveSession,
  getSession,
  addTelegramSession,
  updateSessionId,
  updateSessionActivity,
  removeSession,
} from "./watcher";
