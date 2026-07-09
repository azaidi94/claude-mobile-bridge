/**
 * Live outbound-destination resolution for the persistent session tailers
 * (D2 of the origin-topic outbound refactor).
 *
 * A watch captures its `threadId` at start. That capture is what misroutes when
 * the binding later diverges. Resolving the destination from the topic store at
 * *dispatch* time instead means D1's binding update redirects outbound
 * immediately, with no tailer restart. Falls back to the captured threadId when
 * the mapping is gone (topic deleted) so output is never dropped.
 */

import { topicForSession } from "../../topics/topic-store";
import { launchUuidForPid } from "../../sessions/resolve-session";

export function resolveWatchThread(ws: {
  sessionName: string;
  sessionPid?: number;
  threadId: number;
}): number {
  const launchUuid = launchUuidForPid(ws.sessionPid);
  return (
    topicForSession({ launchUuid, sessionName: ws.sessionName })?.topicId ??
    ws.threadId
  );
}
