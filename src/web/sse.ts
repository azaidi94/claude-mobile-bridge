import { EventEmitter } from "events";

export interface SseEvent {
  type: "text" | "tool" | "thinking" | "segment_end" | "done" | "send_file";
  content: string;
  segmentId?: number;
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
  ): (type: string, content: string, segmentId?: number) => Promise<void> {
    return async (type, content, segmentId) => {
      console.log(
        `[SSE] cb: ${type} listeners=${this.emitter.listenerCount(sessionId)} content=${content.slice(0, 30)}`,
      );
      this.emit(sessionId, {
        type: type as SseEvent["type"],
        content,
        segmentId,
      });
    };
  }
}

export const globalEventBus = new SessionEventBus();
