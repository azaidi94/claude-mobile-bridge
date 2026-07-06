import { warn } from "../logger";
import { isProcessAlive, type PortFileData } from "../relay/discovery";
import type { TopicMapping } from "../topics/topic-store";
import { resolveIdentities } from "./identity";

export function shadowCompareIdentities(
  input: {
    portFiles: PortFileData[];
    topics: TopicMapping[];
    registrySessions: ReadonlyArray<{ claudePid: number; sessionId: string }>;
  },
  log: (msg: string, ctx?: object) => void = warn,
): { compared: number; divergences: number } {
  const aliveRelays = input.portFiles.filter((pf) => isProcessAlive(pf.pid));
  const resolved = resolveIdentities({ aliveRelays, topics: input.topics });

  // Resolver's authoritative id per live claudePid (the only ids it asserts).
  const resolverAuthById = new Map<number, string>();
  for (const r of resolved) {
    if (r.claudePid > 0 && r.provenance === "authoritative" && r.sessionId) {
      resolverAuthById.set(r.claudePid, r.sessionId);
    }
  }
  // Which claudePids have a LIVE relay at all (to avoid blaming the resolver for
  // a registry entry whose process is already gone).
  const liveClaudePids = new Set<number>(
    resolved.filter((r) => r.claudePid > 0).map((r) => r.claudePid),
  );
  const registryById = new Map<number, string>();
  for (const s of input.registrySessions) {
    if (s.claudePid > 0 && s.sessionId)
      registryById.set(s.claudePid, s.sessionId);
  }

  const pids = new Set<number>([
    ...resolverAuthById.keys(),
    ...registryById.keys(),
  ]);
  let compared = 0;
  let divergences = 0;
  for (const pid of pids) {
    compared++;
    const resolverId = resolverAuthById.get(pid);
    const registryId = registryById.get(pid);
    let kind: string | null = null;
    if (resolverId && registryId && resolverId !== registryId) {
      kind = "registry_resolver_disagree";
    } else if (registryId && !resolverId && liveClaudePids.has(pid)) {
      kind = "registry_only";
    } else if (resolverId && !registryId) {
      kind = "resolver_only";
    }
    if (kind) {
      divergences++;
      log(`identity-shadow: ${kind}`, {
        claudePid: pid,
        resolver: resolverId ?? null,
        registry: registryId ?? null,
      });
    }
  }
  return { compared, divergences };
}
