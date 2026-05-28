/**
 * Central tail-event router. Owns:
 *
 *   - `bridgeTailToSse` — map TailEvent → SseEvent for the Web UI surface.
 *   - `handleTailEvent` — switch on event.type and delegate to the
 *     per-domain renderers (text, tool-header, tool-result, permission,
 *     hook, user). Manages watchdog bookkeeping + typing liveness +
 *     bridge-offline drop.
 *
 * Renderer modules import from `state` and `text-renderer` (the shared
 * segment-reset/finalize helpers), but MUST NOT import this file — keeping
 * `event-router.ts` as the trunk avoids cycles.
 */

import type { Api } from "grammy";
import {
  escapeHtml,
  formatTaskNotification,
  stripLocalCommandCaveat,
} from "../../formatting";
import { debug } from "../../logger";
import { isBridgeOnline } from "../../bridge-health";
import { getMessageBus } from "../../messaging";
import type { TailEvent } from "../../sessions/tailer";
import { globalEventBus, type SseEvent } from "../../web/sse";
import { firePendingRunCompletion } from "./idle-watchdog";
import { renderHookSummary } from "./hook-cards";
import { renderPermissionMode } from "./permission-banner";
import { isWatchState, type SseBus, type TailDisplayState } from "./state";
import {
  renderRelayReply,
  renderText,
  resetDisplaySegment,
} from "./text-renderer";
import {
  renderAskUserQuestion,
  renderThinking,
  renderTool,
} from "./tool-headers";
import { renderToolResult } from "./tool-results";
import { stopWatchTyping, touchWatchTyping } from "./typing";

/**
 * Map a TailEvent to an SseEvent and emit it to the session's SSE bus.
 * Skips own-origin events (the web client optimistically added its own send;
 * echoing via SSE would duplicate). Web-specific drop: turn_boundary has no
 * display-reset semantics in the web renderer.
 */
export function bridgeTailToSse(
  bus: SseBus,
  sessionId: string,
  event: TailEvent,
): void {
  if (event.originChat === "web") return;

  switch (event.type) {
    case "user":
      // user events are emitted to the bus as user_message+source by
      // handleTailEvent; doing it here as well would produce a second
      // pane in the Web UI ("You" via "› " prefix on top of "🖥 Remote"
      // / "📱 Telegram" via the source-aware emit).
      return;
    case "text":
      bus.emit(sessionId, { type: "text", content: event.content } as SseEvent);
      return;
    case "tool":
      bus.emit(sessionId, {
        type: "tool",
        content: event.content,
        toolName: event.toolName,
        toolInput: event.toolInput,
        toolUseId: event.toolUseId,
      } as SseEvent);
      return;
    case "thinking":
      bus.emit(sessionId, {
        type: "thinking",
        content: event.content,
      } as SseEvent);
      return;
    case "relay_reply":
      bus.emit(sessionId, { type: "text", content: event.content } as SseEvent);
      return;
    case "turn_boundary":
      return;
    case "turn_end":
      // The web client treats SSE `done` as "streaming finished → re-enable
      // input." Without this, streaming stays true forever when the user
      // drives CC from the terminal/TG and the web UI is watching the
      // same session — the input stays disabled.
      bus.emit(sessionId, { type: "done", content: "" } as SseEvent);
      return;
    case "tool_result":
      bus.emit(sessionId, {
        type: "tool_result",
        content: event.content,
        toolUseId: event.toolUseId,
        isError: event.isError,
      } as SseEvent);
      return;
    case "permission_mode":
      bus.emit(sessionId, {
        type: "permission_mode",
        content: event.permissionMode ?? "",
        permissionMode: event.permissionMode,
      } as SseEvent);
      return;
    case "hook_summary":
      bus.emit(sessionId, {
        type: "hook_summary",
        content: event.content,
        hook: event.hook,
      } as SseEvent);
      return;
  }
}

/**
 * Handle a parsed tail event and display it in Telegram.
 * Shared by both /watch and relay display pipelines.
 */
export function handleTailEvent(
  botApi: Api,
  state: TailDisplayState,
  event: TailEvent,
  threadId?: number,
): void {
  if (state.finalReplyReceived) return;

  // Drop sends while the bridge is offline — grammy's send queue otherwise
  // accumulates and drains at TG's ~1 msg/sec on reconnect. Watchdog state
  // still ticks so it doesn't false-fire as "stuck" once the bridge is back.
  if (!isBridgeOnline()) {
    if (isWatchState(state)) {
      state.lastEventTime = Date.now();
      state.watchdogFired = false;
      state.skippedWhileOffline = (state.skippedWhileOffline ?? 0) + 1;
    }
    return;
  }

  const { chatId } = state;
  const threadOpts = threadId ? { message_thread_id: threadId } : {};
  const bus = getMessageBus();

  // Watchdog bookkeeping: every event resets the idle clock. Mid-turn flag
  // tracks whether Claude owes the user a continuation. Cleared by the same
  // end-of-turn markers that stop the typing liveness indicator below.
  if (isWatchState(state)) {
    state.lastEventTime = Date.now();
    state.watchdogFired = false;
    if (
      event.type === "turn_end" ||
      event.type === "turn_boundary" ||
      event.type === "user" ||
      event.type === "relay_reply"
    ) {
      state.midTurn = false;
    } else if (
      event.type === "text" ||
      event.type === "tool" ||
      event.type === "thinking"
    ) {
      // Allowlist: only Claude-is-actually-working events arm the watchdog.
      // Metadata events (permission_mode, hook_summary, tool_result, usage)
      // and any future event types do not change midTurn — otherwise an
      // out-of-band event during quiet time would falsely arm the idle clock.
      state.midTurn = true;
    }
  }

  // Liveness typing - every tail event means Claude is alive and working —
  // extend the indicator. Only the explicit end-of-turn markers stop it.
  // Only for watches (threadId present); relay display has no topic context.
  if (threadId !== undefined) {
    if (event.type === "turn_end" || event.type === "turn_boundary") {
      debug("typing.stop", { chatId, threadId, via: event.type });
      stopWatchTyping(chatId, threadId);
    } else {
      debug("typing.touch", { chatId, threadId, via: event.type });
      touchWatchTyping(botApi, chatId, threadId);
    }
  }

  switch (event.type) {
    case "thinking":
      renderThinking(botApi, state, event, threadId);
      break;

    case "tool":
      renderTool(botApi, state, event, threadId);
      break;

    case "ask_user_question":
      renderAskUserQuestion(botApi, state, event, threadId);
      break;

    case "tool_result":
      renderToolResult(botApi, state, event, threadId);
      break;

    case "permission_mode":
      renderPermissionMode(botApi, state, event, threadId);
      break;

    case "hook_summary":
      renderHookSummary(botApi, state, event, threadId);
      break;

    case "text":
      renderText(botApi, state, event, threadId);
      break;

    case "relay_reply": {
      renderRelayReply(botApi, state, event, threadOpts.message_thread_id);
      firePendingRunCompletion(botApi, state, threadOpts.message_thread_id);
      // Existing cleanup.
      if (state.finalReplyReceived !== undefined) {
        state.finalReplyReceived = true;
      }
      resetDisplaySegment(botApi, state);
      break;
    }

    case "turn_boundary": {
      // No user-visible output: the user's own Telegram msg is already shown.
      resetDisplaySegment(botApi, state);
      break;
    }

    case "turn_end": {
      // Liveness signal only — already handled above by stopWatchTyping.
      // No rendering side effect.
      break;
    }

    case "user": {
      const ownChat = String(chatId);

      // Web-sourced messages were already emitted to the bus by the
      // POST /message handler; nothing to do here.
      if (event.originChat === "web") break;

      // Own TG chat: text.ts already emitted a user_message+telegram to the
      // bus right after sendWatchRelay returned, AND the user can see their
      // own message in the TG topic natively. Bail before re-emitting —
      // otherwise the Web UI's session pane shows two stacked '📱 Telegram'
      // entries per message (text.ts's emit + this handler's emit).
      if (event.originChat === ownChat) break;

      // <task-notification> is a Claude Stop-hook injection, not real user
      // input. Render the card to TG and skip the bus emit — otherwise the
      // cross-post subscriber forwards the raw XML as "🖥 Terminal: ..."
      // and SSE/cursor consumers see it as a user message too.
      const taskCard = formatTaskNotification(event.content);
      if (taskCard) {
        resetDisplaySegment(botApi, state);
        bus
          .send({
            chatId,
            threadId,
            content: taskCard,
            format: "html",
            silent: true,
          })
          .catch(() => {});
        break;
      }

      // Strip CC's <local-command-caveat> disclaimer (injected when the user
      // runs a `!`-prefix local command). Empty after strip ⇒ pure noise, skip
      // entirely. Otherwise propagate the cleaned text downstream.
      const content = stripLocalCommandCaveat(event.content);
      if (!content) break;

      // Always emit a user_message to the bus so SSE consumers (Web UI)
      // see the user input in a single, source-labelled remote pane.
      // Source labels:
      //   - originChat set (foreign TG chat) → "telegram"
      //   - originChat undefined             → "terminal" (native CC input)
      // Own-chat TG already returned above. setupCrossPostSubscription
      // filters source=telegram, so foreign TG messages don't echo back.
      const busKey = isWatchState(state) ? state.sessionName : ownChat;
      globalEventBus.emit(busKey, {
        type: "user_message",
        source: event.originChat !== undefined ? "telegram" : "terminal",
        content,
      });

      resetDisplaySegment(botApi, state);

      // Native terminal input — setupCrossPostSubscription forwards the
      // bus emit above as "🖥 Terminal: ..." to TG.
      if (event.originChat === undefined) break;

      // Foreign Telegram chat — direct send with cross-chat label.
      const preview =
        content.length > 300 ? content.slice(0, 300) + "…" : content;
      const labelHtml = `💬 <b>Chat ${escapeHtml(event.originChat)}:</b>`;

      // Bus owns markdown→HTML for `preview` (format="auto") and plain-fallback.
      bus
        .send({
          chatId,
          threadId,
          content: `${labelHtml}\n${preview}`,
          format: "auto",
          silent: true,
        })
        .catch((err) => debug(`tail user: ${err}`));
      break;
    }

    case "usage":
      // Handled by the tailer-callback wrapper in lifecycle.ts (maybeNotifyContextCrossing).
      break;
  }
}
