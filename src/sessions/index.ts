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
  removeChatId,
  loadChatIds,
  createNotificationHandler,
  getChatIds,
  setSessionOfflineCallback,
  suppressDirNotifications,
} from "./notifications";

export { SessionTailer, findSessionJsonlPath } from "./tailer";

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

export {
  getRecentHistory,
  formatHistoryMessage,
  sendSwitchHistory,
} from "./history";
