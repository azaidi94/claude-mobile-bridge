import { warn } from "../logger";
import { isProcessAlive, type PortFileData } from "../relay/discovery";
import type { SessionInfo } from "./types";
import type { TopicMapping } from "../topics/topic-store";
import {
  checkIdentityInvariants,
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
