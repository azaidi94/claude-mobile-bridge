/**
 * Relay bridge — sends a message through the channel relay to a running
 * desktop Claude session.
 */

import type { Context } from "grammy";
import type { SessionContext } from "../sessions/context";
import { getWorkingDir } from "../settings";
import type { RelayClient, RelayDisplayState } from "../relay";
import {
  getRelayClient,
  createRelayDisplayState,
  wireRelayDisplay,
  cleanupProgressMessages,
} from "../relay";
import { handleTailEvent, isWatching, sendWatchRelay } from "./watch";
import { SessionTailer, findSessionJsonlPath } from "../sessions/tailer";
import { RELAY_RESPONSE_TIMEOUT_MS } from "../config";
import { startTypingIndicator } from "../utils";
import { debug, elapsedMs, info, warn } from "../logger";

export type RelayResult = "delivered" | "unavailable" | "failed";

export async function sendViaRelay(
  ctx: Context,
  message: string,
  username: string,
  chatId: number,
  imagePath?: string,
  opId?: string,
  threadId?: number,
  sctx?: SessionContext,
): Promise<RelayResult> {
  // Watch's JSONL tailer + wireRelayDisplay TCP would both send the reply;
  // route through sendWatchRelay to avoid the duplicate display path.
  if (threadId !== undefined && isWatching(chatId, threadId)) {
    const relayed = await sendWatchRelay(
      chatId,
      threadId,
      username,
      message,
      opId,
      imagePath,
      sctx,
    );
    if (relayed) return "delivered";
  }

  // Cursor sessions have no CC relay port file; sending via the CC relay
  // would fall back to dir-only matching and could route to an unrelated CC
  // session that shares the dir. Guard explicitly on the source.
  if (sctx?.source === "cursor") {
    return "unavailable";
  }

  // sctx is the authoritative source when topic-resolved. Without it (e.g.
  // private-DM compatibility path), fall back to the bot's default working
  // dir so dir-only relay match can still succeed. Notably we do NOT consult
  // any global "active session" pointer — those mis-targeted whenever a
  // Cursor session was most-recently active.
  const sessionId = sctx?.sessionId;
  const sessionDir = sctx?.sessionDir || getWorkingDir();
  if (!sessionDir) return "unavailable";
  const startedAt = Date.now();

  const client = await getRelayClient({
    sessionId: sessionId || undefined,
    sessionDir,
    claudePid: sctx?.sessionPid,
  });
  if (!client) return "unavailable";

  info("relay: sending", {
    chatId,
    username,
    sessionDir,
    sessionId,
    hasImage: Boolean(imagePath),
  });

  const typing = startTypingIndicator(ctx);
  const displayState = createRelayDisplayState(chatId, threadId);
  const cleanupCallbacks = wireRelayDisplay(ctx.api, client, displayState);

  // Start JSONL tailer for live progress
  let tailer: SessionTailer | null = null;
  if (sessionId) {
    const jsonlPath = await findSessionJsonlPath(sessionId);
    if (jsonlPath) {
      tailer = new SessionTailer(jsonlPath, (event) => {
        // TCP relay (wireRelayDisplay) owns the final reply; skip relay_reply
        // from the tailer to avoid sending the same message twice.
        if (event.type === "relay_reply") return;
        handleTailEvent(ctx.api, displayState, event);
      });
      await tailer.start();
    }
  }

  const sent = client.sendMessage({
    chat_id: String(chatId),
    user: username,
    text: message,
    ...(imagePath ? { image_path: imagePath } : {}),
  });
  if (!sent) {
    warn("relay: send failed, not connected", {
      opId,
      chatId,
      sessionDir,
      sessionId,
    });
    tailer?.stop();
    cleanupCallbacks();
    typing.stop();
    return "failed";
  }

  let result: RelayResult = "delivered";
  try {
    await waitForReply(client, displayState, String(chatId));
  } catch (err) {
    warn("relay: wait failed", err, {
      opId,
      chatId,
      sessionDir,
      sessionId,
      finalReplyReceived: displayState.finalReplyReceived,
      durationMs: elapsedMs(startedAt),
    });
    cleanupProgressMessages(ctx.api, displayState);
    if (!displayState.finalReplyReceived) {
      result = "failed";
      warn("relay: delivery failed", {
        opId,
        chatId,
        sessionDir,
        sessionId,
      });
    }
  }

  tailer?.stop();
  cleanupCallbacks();
  typing.stop();

  if (result === "delivered") {
    info("relay: completed", {
      opId,
      chatId,
      sessionDir,
      sessionId,
      durationMs: elapsedMs(startedAt),
      path: imagePath ? "image" : "text",
    });
  }

  return result;
}

/**
 * Event-driven wait for the relay to deliver a final reply.
 */
function waitForReply(
  client: RelayClient,
  state: RelayDisplayState,
  chatId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      client.offReply(onReply);
      client.offDisconnect(onDisconnect);
    };

    const onReply = () => {
      cleanup();
      // Small delay to let the reply message send
      setTimeout(resolve, 500);
    };

    // Scope to this chat so other chats' replies don't resolve us
    client.onReply(onReply, chatId);

    const onDisconnect = () => {
      cleanup();
      if (!state.finalReplyReceived) {
        reject(new Error("relay disconnected"));
      } else {
        resolve();
      }
    };
    client.onDisconnect(onDisconnect);

    const timeout = setTimeout(() => {
      cleanup();
      if (!state.finalReplyReceived) {
        reject(new Error("relay response timeout"));
      } else {
        resolve();
      }
    }, RELAY_RESPONSE_TIMEOUT_MS);
  });
}
