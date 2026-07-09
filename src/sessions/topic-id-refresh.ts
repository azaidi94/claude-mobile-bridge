/**
 * Keep the topic store's `sessionId` in step with the live session.
 *
 * A topic mapping captures `sessionId` once, at topic creation. When the desktop
 * session runs `/clear` (or resumes), Claude Code starts a NEW session id; the
 * session-id hook refreshes the relay port file, but nothing refreshes the
 * topic store — so its bound id goes stale. That breaks every sessionId-keyed
 * lookup (notably the AUQ bridge route, which then 404s and falls back to the
 * cwd path, which fails the moment the session works in a subdirectory).
 *
 * This planner is **registry-first, port-file-fallback**. The registry
 * (`~/.claude-mobile-bridge/registry/<launchUuid>.json`) is the authoritative,
 * launchUuid-keyed identity source — it is re-anchored by the SessionStart hook
 * itself on every `/clear`. The relay port file is a side-channel that a live
 * soak showed can go stale/corrupt under `/clear` churn (one session's port
 * file was observed carrying a sibling's orphaned sessionId). So: for any
 * topic that has a `launchUuid` (hook-bearing), the sessionId is read from the
 * registry by launchUuid — never from the port file, even if the port file
 * disagrees. Topics with NO launchUuid (R1: Cursor/bare sessions, which the
 * hook never touches) fall back to the old port-file/topicName matching, with
 * the same ambiguity guard as before: it refuses to act when two live port
 * files claim the same topic with *different* ids.
 */

export interface PortFileIdView {
  topicName?: string;
  sessionId?: string;
}

export interface TopicIdView {
  sessionName: string;
  sessionId?: string;
  launchUuid?: string;
}

export interface TopicSessionIdUpdate {
  sessionName: string;
  sessionId: string;
}

export interface RegistryIdView {
  launchUuid: string;
  sessionId: string;
}

export function topicSessionIdRefreshPlan(
  registry: RegistryIdView[], // authoritative, launchUuid-keyed
  portFiles: PortFileIdView[], // R1 fallback for topics with no launchUuid
  topics: TopicIdView[],
): TopicSessionIdUpdate[] {
  const sessionIdByLaunchUuid = new Map<string, string>();
  for (const r of registry) {
    if (r.launchUuid && r.sessionId)
      sessionIdByLaunchUuid.set(r.launchUuid, r.sessionId);
  }

  const updates: TopicSessionIdUpdate[] = [];

  // Pass 1 — hook-bearing topics: authoritative sessionId from the registry.
  for (const t of topics) {
    if (!t.launchUuid) continue;
    const sid = sessionIdByLaunchUuid.get(t.launchUuid);
    if (!sid) continue; // launchUuid not in registry yet (pending) → don't touch
    if (t.sessionId !== sid)
      updates.push({ sessionName: t.sessionName, sessionId: sid });
  }

  // Pass 2 — R1 fallback: topics with NO launchUuid keep the old port-file
  // topicName matching (Cursor/bare sessions have no registry launchUuid).
  const currentBySession = new Map<string, string | undefined>();
  for (const t of topics) {
    if (t.launchUuid) continue; // handled by Pass 1
    currentBySession.set(t.sessionName, t.sessionId);
  }
  const claims = new Map<string, Set<string>>();
  for (const pf of portFiles) {
    if (!pf.sessionId || !pf.topicName) continue;
    if (!currentBySession.has(pf.topicName)) continue;
    let ids = claims.get(pf.topicName);
    if (!ids) {
      ids = new Set();
      claims.set(pf.topicName, ids);
    }
    ids.add(pf.sessionId);
  }
  for (const [sessionName, ids] of claims) {
    if (ids.size !== 1) continue; // ambiguous → don't guess
    const sessionId = [...ids][0]!;
    if (currentBySession.get(sessionName) !== sessionId) {
      updates.push({ sessionName, sessionId });
    }
  }

  return updates;
}
