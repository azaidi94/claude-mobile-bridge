import { warn } from "../logger";
import { isProcessAlive, type PortFileData } from "../relay/discovery";
import type { TopicMapping } from "../topics/topic-store";
import { resolveIdentities } from "./identity";

export function shadowCompareIdentities(
  input: {
    portFiles: PortFileData[];
    topics: TopicMapping[];
    registryIdFor: (claudePid: number) => string | undefined;
  },
  log: (msg: string, ctx?: object) => void = warn,
): { compared: number; divergences: number } {
  const aliveRelays = input.portFiles.filter((pf) => isProcessAlive(pf.pid));
  const resolved = resolveIdentities({ aliveRelays, topics: input.topics });
  let compared = 0;
  let divergences = 0;
  for (const r of resolved) {
    // WS-3a scope (by design): we only compare the `authoritative` subset, where
    // both sides already hold a sessionId for this Claude pid. That proves the
    // resolver copies authoritative ids correctly — NOT that it reproduces the
    // registry's harder decisions (cwd-fallback, sibling routing) or the
    // registry-found/resolver-missing direction. WS-3b must widen this before
    // migrating the watcher. A clean soak here = "zero divergences on authoritative ids".
    if (r.provenance !== "authoritative" || !r.sessionId) continue;
    // Guard: claudePid <= 0 means ppid was absent — unresolvable, skip.
    if (r.claudePid <= 0) continue;
    compared++;
    const registryId = input.registryIdFor(r.claudePid);
    if (registryId && registryId !== r.sessionId) {
      divergences++;
      log("identity-shadow: registry/resolver sessionId divergence", {
        claudePid: r.claudePid,
        cwd: r.cwd,
        resolver: r.sessionId,
        registry: registryId,
      });
    }
  }
  return { compared, divergences };
}
