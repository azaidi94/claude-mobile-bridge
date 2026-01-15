/**
 * Session types for multi-session management.
 */

export interface SessionInfo {
  id: string;              // Claude session UUID
  name: string;            // Human-friendly name
  dir: string;             // Working directory
  lastActivity: number;    // Unix timestamp
  source: 'telegram' | 'desktop' | 'claudet';
}

export interface SessionRegistry {
  sessions: Record<string, SessionInfo>;  // keyed by name
  active: string | null;
}

export interface SessionListItem {
  name: string;
  info: SessionInfo;
  alive: boolean;
  isActive: boolean;
}
