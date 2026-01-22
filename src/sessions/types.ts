/**
 * Session types for multi-session management.
 */

export interface SessionInfo {
  id: string; // Claude session UUID
  name: string; // Human-friendly name
  dir: string; // Working directory
  lastActivity: number; // Unix timestamp
  source: "telegram" | "desktop";
}
