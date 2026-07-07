import { warn } from "../logger";
import { isProcessAlive, type PortFileData } from "../relay/discovery";
import type { SessionInfo } from "./types";
import type { TopicMapping } from "../topics/topic-store";
import {
  checkIdentityInvariants,
  checkResolveSessionInvariant,
  type IdentityViolation,
} from "./identity-invariants";

export function reportIdentityViolations(
  input: {
    sessions: SessionInfo[];
    topics: TopicMapping[];
    portFiles: PortFileData[];
  },
  log: (msg: string, ctx?: object) => void = warn,
): IdentityViolation[] {
  const aliveRelays = input.portFiles.filter((pf) => isProcessAlive(pf.pid));
  const violations = checkIdentityInvariants({
    sessions: input.sessions,
    topics: input.topics,
    aliveRelays,
  });

  // P1 Task N+1 (observe-only regression gate): every live authoritative
  // desktop session's resolveSession answer must match the watcher registry.
  const registry = input.sessions
    .filter((s) => s.source === "desktop" && s.id && s.pid)
    .map((s) => ({
      id: s.id,
      claudePid: s.pid!,
      topicId: input.topics.find((t) => t.sessionId === s.id)?.topicId ?? null,
    }));
  violations.push(
    ...checkResolveSessionInvariant({
      registry,
      snapshot: { aliveRelays, topics: input.topics },
    }),
  );

  for (const v of violations) {
    log(`identity: ${v.kind}`, {
      detail: v.detail,
      sessionId: v.sessionId,
      sessionName: v.sessionName,
      cwd: v.cwd,
    });
  }
  return violations;
}
