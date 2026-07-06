import type { SessionInfo } from "./types";
import type { TopicMapping } from "../topics/topic-store";
import type { PortFileData } from "../relay/discovery";

export type IdentityViolation = {
  kind:
    | "duplicate_topic_for_session"
    | "store_disagreement"
    | "missing_session_id"
    | "ambiguous_siblings";
  sessionId?: string;
  sessionName?: string;
  cwd?: string;
  detail: string;
};

export function checkIdentityInvariants(input: {
  sessions: SessionInfo[];
  topics: TopicMapping[];
  aliveRelays: PortFileData[];
}): IdentityViolation[] {
  const { sessions, topics, aliveRelays } = input;
  const out: IdentityViolation[] = [];

  // I1: no sessionId may back two topics.
  const topicsBySid = new Map<string, TopicMapping[]>();
  for (const t of topics) {
    if (!t.sessionId) continue;
    const arr = topicsBySid.get(t.sessionId) ?? [];
    arr.push(t);
    topicsBySid.set(t.sessionId, arr);
  }
  for (const [sid, ts] of topicsBySid) {
    if (ts.length > 1) {
      out.push({
        kind: "duplicate_topic_for_session",
        sessionId: sid,
        detail: `sessionId ${sid} maps to ${ts.length} topics: ${ts
          .map((t) => t.topicId)
          .join(", ")}`,
      });
    }
  }

  // I2/I4: for a given sessionName, the topic-store id, registry id, and live
  // port-file id must agree (when each is present and non-empty).
  const names = new Set<string>([
    ...topics.map((t) => t.sessionName),
    ...sessions.map((s) => s.name),
    ...aliveRelays.flatMap((r) => (r.sessionName ? [r.sessionName] : [])),
  ]);
  for (const name of names) {
    const ids = new Set<string>();
    const topId = topics.find((t) => t.sessionName === name)?.sessionId;
    const regId = sessions.find((s) => s.name === name)?.id;
    const portId = aliveRelays.find((r) => r.sessionName === name)?.sessionId;
    for (const id of [topId, regId, portId]) if (id) ids.add(id);
    if (ids.size > 1) {
      out.push({
        kind: "store_disagreement",
        sessionName: name,
        detail: `name ${name} has divergent ids — topic=${topId ?? "∅"} registry=${regId ?? "∅"} port=${portId ?? "∅"}`,
      });
    }
  }

  // I3: a live relay with no sessionId. Lone → recoverable "missing"; one of
  // several in the same cwd → "ambiguous" (must never be guessed across).
  const relaysByCwd = new Map<string, PortFileData[]>();
  for (const r of aliveRelays) {
    const arr = relaysByCwd.get(r.cwd) ?? [];
    arr.push(r);
    relaysByCwd.set(r.cwd, arr);
  }
  const reportedAmbiguousCwds = new Set<string>();
  for (const r of aliveRelays) {
    if (r.sessionId) continue;
    const siblings = relaysByCwd.get(r.cwd)!.length;
    if (siblings > 1) {
      if (!reportedAmbiguousCwds.has(r.cwd)) {
        reportedAmbiguousCwds.add(r.cwd);
        out.push({
          kind: "ambiguous_siblings",
          cwd: r.cwd,
          detail: `${siblings} live relays in ${r.cwd} lack a sessionId; cannot disambiguate without the SessionStart hook`,
        });
      }
    } else {
      out.push({
        kind: "missing_session_id",
        cwd: r.cwd,
        detail: `live relay pid=${r.pid} in ${r.cwd} has no sessionId (hook missing or JSONL not yet discovered)`,
      });
    }
  }

  return out;
}
