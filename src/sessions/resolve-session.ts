import type { PortFileData } from "../relay/discovery";
import type { TopicMapping } from "../topics/topic-store";
import type { IdentityProvenance } from "./identity";
import { resolveIdentities } from "./identity";

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
  // P1: never produced by resolveSession (every branch returns resolved/miss).
  // Scaffolding for P2, where a known-but-not-yet-live launchId resolves to pending.
  | { status: "pending" }
  | { status: "miss" };

export function makeRecord(
  r: Omit<SessionRecord, "launchId"> & { launchId?: string | null },
): SessionRecord {
  const { launchId, ...rest } = r;
  return { ...rest, launchId: launchId ?? null };
}

export interface ResolveSnapshot {
  aliveRelays: PortFileData[];
  topics: TopicMapping[];
}

/** Build the canonical record set from today's resolver + port-file target fields. */
function buildRecords(snap: ResolveSnapshot): SessionRecord[] {
  const byRelayPid = new Map<number, PortFileData>();
  for (const pf of snap.aliveRelays) byRelayPid.set(pf.pid, pf);
  return resolveIdentities({
    aliveRelays: snap.aliveRelays,
    topics: snap.topics,
  }).map((ri) => {
    const pf = byRelayPid.get(ri.relayPid);
    return makeRecord({
      sessionId: ri.sessionId,
      claudePid: ri.claudePid,
      cwd: ri.cwd,
      relayPort: pf?.port ?? null,
      relayPid: ri.relayPid,
      topicId: ri.topicId,
      tmuxPane: pf?.tmuxPane ?? null,
      tmuxSocket: pf?.tmuxSocket ?? null,
      cmuxWorkspaceId: pf?.cmuxWorkspaceId ?? null,
      provenance: ri.provenance,
    });
  });
}

export function resolveSession(
  handle: Handle,
  snap: ResolveSnapshot,
): Resolution {
  const records = buildRecords(snap);
  const pick = (pred: (r: SessionRecord) => boolean): Resolution => {
    const hits = records.filter(pred);
    if (hits.length === 1) return { status: "resolved", record: hits[0]! };
    if (hits.length === 0) return { status: "miss" };
    // >1 match on a positive-identity handle = ambiguous siblings → never guess.
    return { status: "miss" };
  };
  switch (handle.by) {
    case "sessionId":
      return pick((r) => r.sessionId === handle.sessionId);
    case "pid":
      return pick((r) => r.claudePid === handle.pid);
    case "topicId":
      return pick((r) => r.topicId === handle.topicId);
    case "cwd": {
      const inCwd = records.filter((r) => r.cwd === handle.cwd);
      if (inCwd.length === 1) return { status: "resolved", record: inCwd[0]! };
      return { status: "miss" }; // 0 or ambiguous siblings
    }
    case "launchId":
      return { status: "miss" }; // P1: launchId never populated
  }
}

let _current: ResolveSnapshot = { aliveRelays: [], topics: [] };
export function setCurrentSnapshot(snap: ResolveSnapshot): void {
  _current = snap;
}
export function getCurrentSnapshot(): ResolveSnapshot {
  return _current;
}
