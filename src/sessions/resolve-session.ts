import type { IdentityProvenance } from "./identity";

export type Handle =
  | { by: "sessionId"; sessionId: string }
  | { by: "pid"; pid: number }
  | { by: "cwd"; cwd: string }
  | { by: "topicId"; topicId: number }
  | { by: "launchId"; launchId: string };

export interface SessionRecord {
  launchId: string | null; // P1: always null; populated in P2
  sessionId: string | null;
  claudePid: number;
  cwd: string;
  relayPort: number | null;
  relayPid: number | null;
  topicId: number | null;
  tmuxPane: string | null;
  tmuxSocket: string | null;
  cmuxWorkspaceId: string | null;
  provenance: IdentityProvenance;
}

export type Resolution =
  | { status: "resolved"; record: SessionRecord }
  | { status: "pending" }
  | { status: "miss" };

export function makeRecord(
  r: Omit<SessionRecord, "launchId"> & { launchId?: string | null },
): SessionRecord {
  const { launchId, ...rest } = r;
  return { ...rest, launchId: launchId ?? null };
}
