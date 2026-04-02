/**
 * Relay bridge — sends a message through the channel relay to a running
 * desktop Claude session. Returns true if relay delivered, false if no
 * relay-enabled session was found.
 */

import type { Context } from "grammy";
import { session } from "../session";
import type { RelayClient, RelayDisplayState } from "../relay";
import {
  getRelayClient,
  createRelayDisplayState,
  wireRelayDisplay,
  cleanupProgressMessages,
} from "../relay";
import { handleTailEvent } from "./watch";
import { SessionTailer, findSessionJsonlPath } from "../sessions/tailer";
import { getActiveSession } from "../sessions";
import { RELAY_RESPONSE_TIMEOUT_MS } from "../config";
import { startTypingIndicator } from "../utils";
import { debug, elapsedMs, info, warn } from "../logger";

export async function sendViaRelay(
  ctx: Context,
  message: string,
  username: string,
  chatId: number,
  imagePath?: string,
  opId?: string,
): Promise<boolean> {
  const active = getActiveSession();
  const sessionId = active?.info.id || session.sessionId;
  const sessionDir = session.workingDir || active?.info.dir;
  if (!sessionDir) return false;
  const startedAt = Date.now();

  const client = await getRelayClient({
    sessionId: sessionId || undefined,
    sessionDir,
    claudePid: active?.info.pid,
  });
  if (!client) return false;

  info("relay: sending", {
    chatId,
    username,
    sessionDir,
    sessionId,
    hasImage: Boolean(imagePath),
  });

  const typing = startTypingIndicator(ctx);
  const displayState = createRelayDisplayState(chatId);
  const cleanupCallbacks = wireRelayDisplay(ctx.api, client, displayState);

  // Start JSONL tailer for live progress
  let tailer: SessionTailer | null = null;
  if (sessionId) {
    const jsonlPath = await findSessionJsonlPath(sessionId);
    if (jsonlPath) {
      tailer = new SessionTailer(jsonlPath, (event) => {
        handleTailEvent(ctx.api, displayState, event);
      });
      await tailer.start();
    }
  }

  client.sendMessage({
    chat_id: String(chatId),
    user: username,
    text: message,
    ...(imagePath ? { image_path: imagePath } : {}),
  });

  let relayDelivered = true;
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
      relayDelivered = false;
      warn("relay: falling back to SDK", {
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

  if (relayDelivered) {
    info("relay: completed", {
      opId,
      chatId,
      sessionDir,
      sessionId,
      durationMs: elapsedMs(startedAt),
      path: imagePath ? "image" : "text",
    });
  }

  return relayDelivered;
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
