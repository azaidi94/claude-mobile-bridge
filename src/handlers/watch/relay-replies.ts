/**
 * TCP-relay outbound sends + the per-watch `onReply` wiring shared by both
 * `startWatchingSession` and `startAutoWatch`. The wired callback fans
 * relay replies into Telegram (PDF or text), forwards any file payloads,
 * and sets `suppressRelayReplyText` only after confirmed TG delivery so the
 * JSONL tailer can still rescue dropped sends.
 */

import type { Api } from "grammy";
import { info, warn, elapsedMs } from "../../logger";
import { getRelayClient } from "../../relay";
import type { RelayReply, RelayClient } from "../../relay/client";
import { sendFile, sendPdfReply } from "../../relay/display";
import { getMessageBus } from "../../messaging";
import type { SessionContext } from "../../sessions/context";
import { watches, watchKey } from "./registry";
import type { WatchState } from "./state";

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

  const sent = client.sendMessage({
    chat_id: String(chatId),
    user: username,
    text,
    ...(imagePath ? { image_path: imagePath } : {}),
  });
  if (!sent) {
    warn("watch: relay send failed", {
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

    // Gate suppress on confirmed Telegram delivery so the JSONL-tailer
    // fallback can rescue us when the TCP fast-path silently fails (network
    // blip, TG rate-limit, etc). Previously suppress was set before the
    // send resolved, locking out the fallback in the exact failure case it
    // exists for.
    const markDelivered = (ok: boolean) => {
      if (ok) watchState.suppressRelayReplyText = true;
    };
    if (msg.send_as_pdf && msg.text) {
      sendPdfReply(botApi, chatId, msg.text, msg.pdf_filename, tid)
        .then(markDelivered)
        .catch(() => {});
    } else if (msg.text) {
      getMessageBus()
        .send({ chatId, threadId: tid, content: msg.text, format: "auto" })
        .then((r) => markDelivered("messageId" in r))
        .catch(() => {});
    }

    if (msg.files?.length) {
      for (const filePath of msg.files) {
        sendFile(botApi, chatId, filePath, tid).catch((err) =>
          warn(`${fileErrLabel} file: ${err}`),
        );
      }
    }
  };
  relayClient.onReply(onReply, scopeChatId);
  watchState.relayCleanup = () => relayClient.offReply(onReply);
}
