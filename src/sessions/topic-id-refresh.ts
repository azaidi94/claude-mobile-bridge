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
 * This pure planner matches a live port file to its topic by `topicName` (the
 * sibling-safe key the port file already carries) and reports the sessionId
 * updates the store needs. It deliberately refuses to act when two live port
 * files claim the same topic with *different* ids — guessing there is exactly
 * the same-folder sibling cross-wire the codebase pays to avoid.
 */

export interface PortFileIdView {
  topicName?: string;
  sessionId?: string;
}

export interface TopicIdView {
  sessionName: string;
  sessionId?: string;
}

export interface TopicSessionIdUpdate {
  sessionName: string;
  sessionId: string;
}

export function topicSessionIdRefreshPlan(
  portFiles: PortFileIdView[],
  topics: TopicIdView[],
): TopicSessionIdUpdate[] {
  const currentBySession = new Map<string, string | undefined>();
  for (const t of topics) currentBySession.set(t.sessionName, t.sessionId);

  // topicName → set of distinct live sessionIds claiming it.
  const claims = new Map<string, Set<string>>();
  for (const pf of portFiles) {
    if (!pf.topicName || !pf.sessionId) continue;
    if (!currentBySession.has(pf.topicName)) continue;
    let ids = claims.get(pf.topicName);
    if (!ids) {
      ids = new Set();
      claims.set(pf.topicName, ids);
    }
    ids.add(pf.sessionId);
  }

  const updates: TopicSessionIdUpdate[] = [];
  for (const [sessionName, ids] of claims) {
    if (ids.size !== 1) continue; // ambiguous → don't guess (sibling-safe)
    const sessionId = [...ids][0]!;
    if (currentBySession.get(sessionName) !== sessionId) {
      updates.push({ sessionName, sessionId });
    }
  }
  return updates;
}
