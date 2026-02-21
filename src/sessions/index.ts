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

export {
  registerChatId,
  loadChatIds,
  createNotificationHandler,
  getChatIds,
} from "./notifications";

export {
  loadPinnedMessageIds,
  getPinnedMessageId,
  setPinnedMessageId,
  clearPinnedMessageId,
  formatStatusMessage,
  updatePinnedStatus,
  removePinnedStatus,
  getGitBranch,
  type StatusInfo,
} from "./status-message";
