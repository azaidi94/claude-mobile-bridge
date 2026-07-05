/**
 * Re-export surface for the per-domain command modules.
 *
 * `src/handlers/index.ts`, `src/handlers/callback.ts`, `src/handlers/text.ts`,
 * and the tests all import from `"./commands"` / `"../handlers/commands"`,
 * which resolves to this file. Decomposition is structural only — the public
 * export set matches the prior monolithic `commands.ts`.
 */

export {
  busReply,
  setTopicManager,
  getTopicManager,
  isTopicChat,
  showSessionPicker,
  resolveTopicSession,
  bashSingleQuotedPath,
  escapeAppleScriptDoubleQuoted,
  resolveClaudePathForSpawn,
  assertDesktopSpawnReady,
  relayIdentity,
  tryRealpathSync,
  handleStart,
  handleHelp,
  handleRefresh,
} from "./helpers";

export {
  buildTerminalSpawnArgs,
  buildDesktopShellCommand,
  openMacOSTerminalWithCommand,
} from "./terminal-launchers";

export { spawnDesktopClaudeSession } from "./spawn";

export {
  handleNew,
  handleKill,
  handleRespawn,
  handleList,
  killSession,
  sendPostKillSessionList,
  respawnSession,
} from "./sessions";

export { handleSessions, offlineSessionCache } from "./offline-sessions";

export {
  handleStop,
  handleInterrupt,
  handleStatus,
  handleModel,
  handleRestart,
  handleRetry,
  handlePin,
} from "./control";

export { handleSwitch } from "./switch";

export { handleRun } from "./run";

export { handlePwd, handleCd, handleLs } from "./files";

export { handleApp } from "./app";

export { handleGroupMode, handleGroupModeCallback } from "./group-mode";

export { handleCleanZombie } from "./cleanzombie";

export { handleCron } from "./cron";

export { handlePrompts } from "./prompts";

export { handleClear, handleCompact, handleContext } from "./inject";
