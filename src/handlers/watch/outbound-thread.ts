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

import { getTopicBySession } from "../../topics/topic-store";

export function resolveWatchThread(ws: {
  sessionName: string;
  threadId: number;
}): number {
  return getTopicBySession(ws.sessionName)?.topicId ?? ws.threadId;
}
