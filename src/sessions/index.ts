/**
 * Session management module exports.
 */

export type { SessionInfo, SessionOverride } from "./types";

export {
  resolveSessionContext,
  sessionContextFromInfo,
  type SessionContext,
} from "./context";

export {
  startWatcher,
  stopWatcher,
  forceRefresh,
  getSessions,
  getActiveSessionName,
  setActiveSession,
  getSession,
  addTelegramSession,
  addCursorSession,
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
  setSessionCleanupCallback,
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

export {
  SessionState,
  getSessionState,
  dropSessionState,
  listSessionStates,
  setOnSessionStateCreated,
} from "./session-state";
