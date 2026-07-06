/**
 * The persistent-watch JSONL tailer callback, single-sourced.
 *
 * startAutoWatch, startWatchingSession, and the drift-recovery tailer rebuilds
 * (jsonl-tailer.ts) all attach the same render pipeline. Centralising it here
 * keeps every tailer instance for a watch in lockstep: context-usage tracking,
 * the in-flight relay suppression (D3), live destination resolution (D2), and
 * the SSE bridge. Previously these closures were copy-pasted, and the
 * drift-recovery copies silently missed D2/D3.
 */

import type { Api } from "grammy";
import type { TailEvent } from "../../sessions/tailer";
import { globalEventBus } from "../../web/sse";
import { maybeNotifyContextCrossing } from "./context-usage";
import { bridgeTailToSse, handleTailEvent } from "./event-router";
import { isRelayInflight } from "./inflight-relay";
import { resolveWatchThread } from "./outbound-thread";
import type { WatchState } from "./state";

export function makeWatchTailHandler(
  botApi: Api,
  watchState: WatchState,
): (event: TailEvent) => void {
  return (event) => {
    if (event.type === "usage" && event.usage) {
      void maybeNotifyContextCrossing(botApi, watchState, event.usage);
    }
    // D3: while a request-scoped relay tailer renders this session's turn to
    // the origin topic, suppress this persistent watch so the same JSONL isn't
    // double-streamed. Usage tracking above still runs.
    if (isRelayInflight(watchState.sessionName)) return;
    // D2: resolve the destination live so a rebound binding redirects outbound
    // immediately; falls back to the captured threadId when the mapping is gone.
    handleTailEvent(botApi, watchState, event, resolveWatchThread(watchState));
    bridgeTailToSse(globalEventBus, watchState.sessionName, event);
  };
}
