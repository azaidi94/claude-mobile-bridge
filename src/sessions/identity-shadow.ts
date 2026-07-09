import { info, warn } from "../logger";
import { isProcessAlive, type PortFileData } from "../relay/discovery";
import type { TopicMapping } from "../topics/topic-store";
import { resolveIdentities } from "./identity";
import {
  resolveSession,
  type Handle,
  type ResolveSnapshot,
} from "./resolve-session";

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

type ShadowEvent = {
  site: string;
  handle: Handle;
  current: unknown;
  shadow: unknown;
  reason: string;
};
let _shadowLog: (e: ShadowEvent) => void = (e) =>
  info("identity-shadow: resolveSession divergence", {
    site: e.site,
    current: String(e.current),
    shadow: String(e.shadow),
    reason: e.reason,
  });
/** Test seam. */
export function __setShadowLogger(fn: (e: ShadowEvent) => void): void {
  _shadowLog = fn;
}

/** Reduce a Resolution to the scalar the call site returns (id/topic/port/null). */
function scalar(
  r: ReturnType<typeof resolveSession>,
  want: "sessionId" | "topicId" | "relayPort",
): unknown {
  if (r.status !== "resolved") return r.status === "pending" ? undefined : null;
  return r.record[want];
}

export function shadowLaunchUuid(snap: ResolveSnapshot): void {
  try {
    for (const [pid, uuid] of snap.launchUuidByPid ?? []) {
      const byLaunch = resolveSession({ by: "launchId", launchId: uuid }, snap);
      const byPid = resolveSession({ by: "pid", pid }, snap);
      const a =
        byLaunch.status === "resolved"
          ? byLaunch.record.sessionId
          : byLaunch.status;
      const b =
        byPid.status === "resolved" ? byPid.record.sessionId : byPid.status;
      if (a !== b)
        info("identity-shadow: launchUuid divergence", {
          pid,
          uuid,
          byLaunch: String(a),
          byPid: String(b),
        });
    }
  } catch {
    /* observe-only */
  }
}

export function shadowTopicByLaunchUuid(snap: ResolveSnapshot): void {
  try {
    for (const [pid, uuid] of snap.launchUuidByPid ?? []) {
      const byLaunch = snap.topics.find((t) => t.launchUuid === uuid)?.topicId;
      if (byLaunch === undefined) continue; // not backfilled yet → pending, not divergence
      const res = resolveSession({ by: "pid", pid }, snap);
      const byToday = res.status === "resolved" ? res.record.topicId : null;
      if (byToday === null || byToday === undefined) continue;
      if (byLaunch !== byToday)
        info("identity-shadow: topic launchUuid divergence", {
          pid,
          uuid,
          byLaunch,
          byToday,
        });
    }
  } catch {
    /* observe-only */
  }
}

export function shadowResolveSession(
  site: string,
  currentAnswer: string | number | null,
  handle: Handle,
  snap: ResolveSnapshot,
  want: "sessionId" | "topicId" | "relayPort" = "sessionId",
): void {
  try {
    const shadow = scalar(resolveSession(handle, snap), want);
    // `undefined` (pending) is not a divergence vs a transient current-null.
    if (shadow === undefined) return;
    if (shadow !== currentAnswer) {
      _shadowLog({
        site,
        handle,
        current: currentAnswer,
        shadow,
        reason: "mismatch",
      });
    }
  } catch {
    /* observe-only: never disturb the live path */
  }
}
