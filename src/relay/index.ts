/**
 * Relay module exports.
 */

export { RelayClient } from "./client";
export type { RelayReply, RelayEditMessage, RelayReact } from "./client";
export type { RelaySelector, PortFileData } from "./discovery";

export {
  isRelayAvailable,
  getRelayClient,
  getRelayDirs,
  disconnectRelay,
  disconnectAllRelays,
  scanPortFiles,
  invalidateScanCache,
  selectRelayTarget,
} from "./discovery";

export {
  createRelayDisplayState,
  cleanupProgressMessages,
  wireRelayDisplay,
  type RelayDisplayState,
} from "./display";
