/**
 * Relay module exports.
 */

export { RelayClient } from "./client";
export type { RelayReply, RelayEditMessage, RelayReact } from "./client";

export {
  isRelayAvailable,
  getRelayClient,
  getRelayDirs,
  disconnectRelay,
  disconnectAllRelays,
  scanPortFiles,
  invalidateScanCache,
} from "./discovery";

export {
  createRelayDisplayState,
  cleanupProgressMessages,
  wireRelayDisplay,
  type RelayDisplayState,
} from "./display";
