import type { PortFileData } from "../relay/discovery";
import type { TopicMapping } from "../topics/topic-store";

export type IdentityProvenance = "authoritative" | "ambiguous" | "missing";

export type ResolvedIdentity = {
  claudePid: number;
  relayPid: number;
  cwd: string;
  sessionId: string | null;
  provenance: IdentityProvenance;
  topicId: number | null;
};

export function resolveIdentities(input: {
  aliveRelays: PortFileData[];
  topics: TopicMapping[];
}): ResolvedIdentity[] {
  const { aliveRelays, topics } = input;

  // Count id-less relays per cwd to classify ambiguity.
  const idlessByCwd = new Map<string, number>();
  for (const r of aliveRelays) {
    if (!r.sessionId) idlessByCwd.set(r.cwd, (idlessByCwd.get(r.cwd) ?? 0) + 1);
  }

  const topicBySid = new Map<string, number>();
  for (const t of topics)
    if (t.sessionId) topicBySid.set(t.sessionId, t.topicId);

  return aliveRelays.map((r) => {
    const sessionId = r.sessionId ?? null;
    let provenance: IdentityProvenance;
    if (sessionId) provenance = "authoritative";
    else if ((idlessByCwd.get(r.cwd) ?? 0) > 1) provenance = "ambiguous";
    else provenance = "missing";
    return {
      claudePid: r.ppid ?? 0,
      relayPid: r.pid,
      cwd: r.cwd,
      sessionId,
      provenance,
      topicId: sessionId ? (topicBySid.get(sessionId) ?? null) : null,
    };
  });
}
