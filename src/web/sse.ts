import { EventEmitter } from "events";

export interface SseEvent {
  type: "text" | "tool" | "thinking" | "segment_end" | "done" | "send_file";
  content: string;
  segmentId?: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
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
