/**
 * Session types for multi-session management.
 */

export interface SessionInfo {
  /** Claude session UUID. Empty string ("") until the first message initializes it. */
  id: string;
  name: string; // Human-friendly name
  dir: string; // Working directory
  lastActivity: number; // Unix timestamp
  source: "telegram" | "desktop";
}
