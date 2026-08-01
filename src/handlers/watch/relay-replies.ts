/**
 * TCP-relay outbound sends + the per-watch `onReply` wiring shared by both
 * `startWatchingSession` and `startAutoWatch`. The wired callback fans
 * relay replies into Telegram (PDF or text), forwards any file payloads,
 * and uses the turn-claim protocol (turn-claims.ts) so the JSONL tailer
 * can still rescue dropped sends without duplicating successful ones.
 */

import type { Api } from "grammy";
import { debug, info, warn, elapsedMs } from "../../logger";
import { getRelayClient } from "../../relay";
import type { RelayReply, RelayClient } from "../../relay/client";
import { sendFile, sendPdfReply } from "../../relay/display";
import { getMessageBus } from "../../messaging";
import type { SessionContext } from "../../sessions/context";
import { watches, watchKey } from "./registry";
import type { WatchState } from "./state";
import { claimTurn, releaseClaim, turnClaimKey } from "./turn-claims";

/**
 * Send a message via relay while watching (no takeover).
 * Returns true if relay was used.
 */
export async function sendWatchRelay(
  chatId: number,
  threadId: number,
  username: string,
  text: string,
  opId?: string,
  imagePath?: string,
  /** Override session target (for topic mode where watch may point at a different session). */
  sctx?: SessionContext,
): Promise<boolean> {
  const state = watches.get(watchKey(chatId, threadId));
  if (!state) return false;
  const startedAt = Date.now();

  // Only sessionId, sessionDir, and sessionPid are read from `target`.
  // SessionContext and WatchState are structurally compatible for exactly
  // those three fields; no other properties should be accessed here.
  const target = sctx ?? state;
  const client = await getRelayClient({
    sessionId: target.sessionId,
    sessionDir: target.sessionDir,
    claudePid: target.sessionPid,
  });
  if (!client) return false;

  // After /clear the sessionId changes, the client cache misses, and this
  // lookup returns a FRESH connection (the relay server kicks the old one —
  // along with the reply handler bound to it). Rebind onto the new instance,
  // or reply-tool payloads (files, send_as_pdf) are dropped silently.
  // Never rebind onto a DIFFERENT session's client (topic-mode sctx override):
  // that would steal the watch's binding from its own session and double-fire
  // on the sibling's (reply scoping is chat-level, not thread-level).
  // Identity matches on the STABLE sessionName, not only sessionId: after
  // /clear, sctx re-anchors to the new id immediately (port-file hook) while
  // state.sessionId lags until the drift tick sees the new JSONL — an
  // id-only comparison would skip the rebind exactly on the first
  // post-/clear turn and lose its attachments.
  const ownSession =
    !sctx ||
    sctx.sessionName === state.sessionName ||
    sctx.sessionId === state.sessionId;
  if (ownSession && client !== state.relayClient && state.rebindRelay) {
    state.relayCleanup?.();
    state.rebindRelay(client);
    warn("watch: relay client changed — rebound reply handler", {
      opId,
      chatId,
      topic: threadId,
      session: state.sessionName,
    });
  }

  const sent = client.sendMessage({
    chat_id: String(chatId),
    user: username,
    text,
    ...(imagePath ? { image_path: imagePath } : {}),
  });
  if (!sent) {
    debug("watch: relay send failed", {
      opId,
      chatId,
      threadId,
      sessionName: state.sessionName,
      sessionId: state.sessionId,
      sessionDir: state.sessionDir,
      durationMs: elapsedMs(startedAt),
    });
    return false;
  }
  info("watch: relay queued", {
    opId,
    chatId,
    threadId,
    sessionName: state.sessionName,
    sessionId: state.sessionId,
    sessionDir: state.sessionDir,
    durationMs: elapsedMs(startedAt),
  });
  return true;
}

/**
 * Bind the watch's TCP-relay `onReply` callback and stash a cleanup function
 * on the WatchState. Shared by manual /watch (label `"watch"`) and auto-watch
 * (label `"auto-watch"`) — the only difference is the log prefix on file send
 * failures.
 */
export function bindRelayReplyHandler(
  botApi: Api,
  relayClient: RelayClient,
  watchState: WatchState,
  chatId: number,
  fileErrLabel: "watch" | "auto-watch",
): void {
  const scopeChatId = String(chatId);
  const onReply = (msg: RelayReply) => {
    const tid = watchState.threadId;

    // Claim the turn synchronously before the async send so the JSONL tailer
    // sees the claim even while the send is queued on the bus rate-limiter.
    // On send failure the claim is released so the tailer fallback delivers.
    // See turn-claims.ts for the full protocol.
    if (!watchState.relayReplyClaims) {
      watchState.relayReplyClaims = new Map();
    }
    const claims = watchState.relayReplyClaims;

    if (msg.send_as_pdf && msg.text) {
      const key = turnClaimKey(msg.text);
      claimTurn(claims, key);
      sendPdfReply(botApi, chatId, msg.text, msg.pdf_filename, tid)
        .then((ok) => {
          if (!ok) releaseClaim(claims, key);
        })
        .catch(() => releaseClaim(claims, key));
    } else if (msg.text) {
      const key = turnClaimKey(msg.text);
      claimTurn(claims, key);
      getMessageBus()
        .send({ chatId, threadId: tid, content: msg.text, format: "auto" })
        .then((r) => {
          if (!("messageId" in r)) releaseClaim(claims, key);
        })
        .catch(() => releaseClaim(claims, key));
    }

    if (msg.files?.length) {
      for (const filePath of msg.files) {
        sendFile(botApi, chatId, filePath, tid).catch((err) =>
          debug(`${fileErrLabel} file send failed`, {
            err: String(err),
            chatId,
            topic: tid,
          }),
        );
      }
    }
  };
  relayClient.onReply(onReply, scopeChatId);
  watchState.relayClient = relayClient;
  watchState.relayCleanup = () => relayClient.offReply(onReply);
  armRelayRebind(botApi, watchState, chatId, fileErrLabel);
}

/**
 * Arm rebinding for a watch that started with NO relay client (relay down at
 * watch start). Without this, the `rebindRelay` guard in `sendWatchRelay`
 * skips binding forever and the watch can never deliver reply-tool payloads,
 * even after the relay comes back. Call from session-builder's no-client
 * branch; the first successful send then binds the handler.
 */
export function armRelayRebind(
  botApi: Api,
  watchState: WatchState,
  chatId: number,
  fileErrLabel: "watch" | "auto-watch",
): void {
  watchState.rebindRelay = (next) =>
    bindRelayReplyHandler(botApi, next, watchState, chatId, fileErrLabel);
}
