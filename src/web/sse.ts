import { EventEmitter } from "events";

export interface SseEvent {
  type:
    | "text"
    | "tool"
    | "thinking"
    | "segment_end"
    | "done"
    | "send_file"
    | "tool_result"
    | "permission_mode"
    | "hook_summary"
    | "user_message"
    | "ask_remote"
    | "ask_remote_cleared";
  content: string;
  source?: "telegram" | "web" | "terminal" | "cursor";
  clientId?: string;
  segmentId?: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  isError?: boolean;
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  hook?: {
    hookCount: number;
    errorCount: number;
    preventedContinuation: boolean;
    firstError?: string;
    failingHookName?: string;
  };
  /** ask_remote: identifier for routing the answer back to the MCP. */
  askId?: string;
  /** ask_remote: question text + button options + custom-text affordance. */
  askQuestion?: string;
  askOptions?: Array<{ label: string; description?: string }>;
  askAllowCustom?: boolean;
  /** ask_remote_cleared: how the question was resolved, for UX hint. */
  askResolution?: "answered" | "cancelled" | "timeout" | "expired";
  askAnswer?: string;
}

type SseHandler = (event: SseEvent) => void;

export class SessionEventBus {
  private emitter = new EventEmitter();

  subscribe(sessionId: string, handler: SseHandler): () => void {
    this.emitter.on(sessionId, handler);
    return () => this.emitter.off(sessionId, handler);
  }

  emit(sessionId: string, event: SseEvent): void {
    this.emitter.emit(sessionId, event);
  }

  makeStatusCallback(
    sessionId: string,
  ): (
    type: string,
    content: string,
    segmentId?: number,
    meta?: { toolName?: string; toolInput?: Record<string, unknown> },
  ) => Promise<void> {
    return async (type, content, segmentId, meta) => {
      this.emit(sessionId, {
        type: type as SseEvent["type"],
        content,
        segmentId,
        toolName: meta?.toolName,
        toolInput: meta?.toolInput,
      });
    };
  }
}

export const globalEventBus = new SessionEventBus();
