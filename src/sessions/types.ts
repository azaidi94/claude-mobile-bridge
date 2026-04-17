/**
 * Session types for multi-session management.
 */

/** Subset of session identity used to target a specific relay. */
export interface SessionOverride {
  sessionId: string;
  sessionDir: string;
  sessionPid?: number;
}

export interface SessionInfo {
  /** Claude session UUID. Empty string ("") until the first message initializes it. */
  id: string;
  name: string; // Human-friendly name
  dir: string; // Working directory
  lastActivity: number; // Unix timestamp
  source: "telegram" | "desktop";
  /** Claude Code process PID (desktop sessions only, used for relay disambiguation). */
  pid?: number;
}
