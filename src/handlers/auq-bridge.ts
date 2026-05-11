/**
 * AUQ-bridge orchestrator. Given a registered bridge, post a TG inline-keyboard
 * card and a Web UI `ask_remote` SSE event for each question (sequentially),
 * await an answer on any surface, return all answers when complete. Cancels
 * cleanly when the bot's JSONL tailer signals a local-TUI answer for the
 * matching `tool_use_id`.
 *
 * Collaborators (TG send, SSE emit, JSONL bus subscription) are injected so
 * the orchestrator stays pure and unit-testable.
 */

import { resolve as resolveBridge, get } from "./auq-bridge-registry";
import type { BridgeResolution } from "./auq-bridge-registry";
import type { SseEvent } from "../web/sse";
import { SessionEventBus, globalEventBus } from "../web/sse";

export interface PostTgArgs {
  chatId: number;
  threadId: number;
  askId: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  allowCustom: boolean;
}

export interface BridgeOrchestratorDeps {
  postTg: (args: PostTgArgs) => Promise<{ messageId: number }>;
  emitSse: (ev: SseEvent) => void;
  /** Called when the bridge resolves so each surface can be cleaned up. */
  clearedSse: (askId: string, resolution: "answered" | "cancelled") => void;
}

/**
 * Map of (requestId → per-question waiters) so external callers (TG callback
 * dispatcher, Web UI POST /ask-remote-answer) can deliver an answer to the
 * orchestrator without going through the bus.
 */
const questionWaiters = new Map<
  string,
  Map<number, (answer: string) => void>
>();

function askIdFor(requestId: string, questionIndex: number): string {
  return `bridge:${requestId}:${questionIndex}`;
}

/**
 * Parse `bridge:<request_id>:<question_index>` from a callback / Web UI askId.
 * Returns null if the format doesn't match.
 */
export function parseBridgeAskId(
  askId: string,
): { requestId: string; questionIndex: number } | null {
  if (!askId.startsWith("bridge:")) return null;
  const parts = askId.split(":");
  if (parts.length !== 3) return null;
  const qi = parseInt(parts[2]!, 10);
  if (!Number.isFinite(qi)) return null;
  return { requestId: parts[1]!, questionIndex: qi };
}

/** Called by the TG callback dispatcher when a bridge:* button is tapped. */
export function _injectTgAnswer(
  requestId: string,
  questionIndex: number,
  answer: string,
): boolean {
  const perReq = questionWaiters.get(requestId);
  const waiter = perReq?.get(questionIndex);
  if (!waiter) return false;
  waiter(answer);
  return true;
}

/** Same path for Web UI answers. */
export function _injectWebAnswer(
  requestId: string,
  questionIndex: number,
  answer: string,
): boolean {
  return _injectTgAnswer(requestId, questionIndex, answer);
}

export async function runBridge(
  state: {
    requestId: string;
    chatId: number;
    threadId: number;
    questions: any[];
  },
  deps: BridgeOrchestratorDeps,
): Promise<BridgeResolution> {
  const perReq = new Map<number, (answer: string) => void>();
  questionWaiters.set(state.requestId, perReq);
  try {
    const answers: Array<{ question: string; answer: string }> = [];
    for (let i = 0; i < state.questions.length; i++) {
      const q = state.questions[i];
      const askId = askIdFor(state.requestId, i);
      const allowCustom = q.multiSelect !== true;

      // Register the waiter BEFORE posting to TG so answers that arrive
      // during or immediately after the send are never dropped.
      let resolveAnswer!: (a: string | null) => void;
      const answerPromise = new Promise<string | null>((res) => {
        resolveAnswer = res;
        // If bridge is already cancelled before we even start, resolve now.
        const b = get(state.requestId);
        if (b?.resolution) res(null);
      });
      perReq.set(i, (a) => resolveAnswer(a));

      const sent = await deps.postTg({
        chatId: state.chatId,
        threadId: state.threadId,
        askId,
        question: q.question,
        options: q.options,
        allowCustom,
      });
      const bridge = get(state.requestId);
      if (bridge) bridge.tgMessageIds.set(i, sent.messageId);

      deps.emitSse({
        type: "ask_remote",
        content: q.question,
        askId,
        askQuestion: q.question,
        askOptions: q.options.map((o: any) => ({
          label: o.label,
          description: o.description,
        })),
        askAllowCustom: allowCustom,
      });

      const answer = await answerPromise;
      if (answer === null || get(state.requestId)?.resolution) {
        const final = get(state.requestId)?.resolution ?? {
          status: "cancelled" as const,
          reason: "unknown",
        };
        // Emit cleared for the surface card so it doesn't sit stale.
        deps.clearedSse(
          askId,
          final.status === "answered" ? "answered" : "cancelled",
        );
        return final;
      }
      answers.push({ question: q.question, answer });
      deps.clearedSse(askId, "answered");
    }
    const resolution: BridgeResolution = { status: "answered", answers };
    resolveBridge(state.requestId, resolution);
    return resolution;
  } catch (err) {
    resolveBridge(state.requestId, {
      status: "cancelled",
      reason: `orchestrator error: ${err instanceof Error ? err.message : String(err)}`,
    });
    throw err;
  } finally {
    questionWaiters.delete(state.requestId);
  }
}

/**
 * Subscribe to the bus for the bridge's session. When a `tool_result` event
 * arrives with the matching `tool_use_id`, mark the bridge cancelled and wake
 * the currently-pending per-question waiter so `runBridge` returns immediately.
 */
export function attachBusCancellation(
  state: {
    requestId: string;
    toolUseId: string;
    sessionName: string;
  },
  bus: SessionEventBus = globalEventBus,
): () => void {
  const unsub = bus.subscribe(state.sessionName, (evt) => {
    if (evt.type !== "tool_result") return;
    if (evt.toolUseId !== state.toolUseId) return;
    const cancelled = {
      status: "cancelled" as const,
      reason: "answered_locally",
    };
    resolveBridge(state.requestId, cancelled);
    // Wake the active per-question waiter so `runBridge`'s await unblocks.
    // Use empty string (not null) because the waiter signature is
    // `(answer: string) => void`. The orchestrator distinguishes a legit
    // empty answer from a cancellation via the secondary `get(...).resolution`
    // check in runBridge — that's already been set by resolveBridge above.
    const perReq = questionWaiters.get(state.requestId);
    if (perReq) for (const [, w] of perReq) w("");
  });
  return unsub;
}

import type { Api } from "grammy";
import { sendBridgeQuestion, editBridgeCardCancelled } from "./relay-ask";

let botApi: Api | null = null;
export function setBotApiForBridge(api: Api): void {
  botApi = api;
}

/**
 * Called by the HTTP route to kick off the orchestrator + bus cancellation
 * for a freshly-registered bridge. Resolves when the bridge resolves.
 * Important: this function also calls the unsub from attachBusCancellation
 * when the bridge resolves so we don't leak bus listeners.
 */
export async function startBridgeFromRoute(requestId: string): Promise<void> {
  const state = get(requestId);
  if (!state) return;
  const unsubBus = botApi ? attachBusCancellation(state) : () => {};

  try {
    await runBridge(state, {
      postTg: async (args) => {
        if (!botApi) return { messageId: 0 };
        const parsed = parseBridgeAskId(args.askId);
        if (!parsed) return { messageId: 0 };
        const messageId = await sendBridgeQuestion(botApi, {
          requestId: parsed.requestId,
          questionIndex: parsed.questionIndex,
          chatId: args.chatId,
          threadId: args.threadId,
          question: args.question,
          options: args.options,
          allowCustom: args.allowCustom,
        });
        return { messageId };
      },
      emitSse: (ev) => globalEventBus.emit(state.sessionName, ev),
      clearedSse: (askId, resolution) => {
        globalEventBus.emit(state.sessionName, {
          type: "ask_remote_cleared",
          content: "",
          askId,
          askResolution: resolution === "answered" ? "answered" : "cancelled",
        });
        // Edit the corresponding TG card if we still have its message id.
        const parsed = parseBridgeAskId(askId);
        if (parsed && botApi) {
          const messageId = state.tgMessageIds.get(parsed.questionIndex);
          if (messageId && messageId > 0) {
            void editBridgeCardCancelled(
              botApi,
              state.chatId,
              messageId,
              state.threadId,
              resolution === "answered" ? "answered_locally" : "cancelled",
            );
          }
        }
      },
    });
  } finally {
    unsubBus();
  }
}
