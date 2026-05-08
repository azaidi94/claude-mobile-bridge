export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface WebSocketLike {
  onopen: ((this: WebSocketLike) => void) | null;
  onmessage: ((this: WebSocketLike, event: { data: string }) => void) | null;
  onclose: ((this: WebSocketLike) => void) | null;
  onerror: ((this: WebSocketLike, error: unknown) => void) | null;
  send(data: string): void;
  close(): void;
  readyState: number;
}

export async function listCdpTargets(port = 9222): Promise<CdpTarget[]> {
  const res = await fetch(`http://localhost:${port}/json`);
  return res.json() as Promise<CdpTarget[]>;
}

export function connectCdpTarget(wsUrl: string): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl) as unknown as WebSocketLike;
    const client = new CdpClient(ws);
    ws.onopen = () => resolve(client);
    ws.onerror = (err: unknown) => reject(err);
  });
}

type NotificationHandler = (params: Record<string, unknown>) => void;

export class CdpClient {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private notificationHandlers = new Map<string, NotificationHandler[]>();

  constructor(private ws: WebSocketLike) {
    const drainPending = (reason: string) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(reason));
      }
      this.pending.clear();
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        result?: unknown;
        error?: { message: string };
        params?: Record<string, unknown>;
      };

      if (msg.id !== undefined) {
        const handler = this.pending.get(msg.id);
        if (!handler) return;
        this.pending.delete(msg.id);
        if (msg.error) {
          handler.reject(new Error(msg.error.message));
        } else {
          handler.resolve(msg.result);
        }
      } else if (msg.method) {
        const handlers = this.notificationHandlers.get(msg.method);
        if (handlers) {
          for (const h of handlers) h(msg.params ?? {});
        }
      }
    };

    ws.onclose = () => drainPending("WebSocket closed");
    ws.onerror = (err) => drainPending(`WebSocket error: ${String(err)}`);
  }

  sendCommand(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    const existing = this.notificationHandlers.get(method) ?? [];
    existing.push(handler);
    this.notificationHandlers.set(method, existing);
    return () => {
      const handlers = this.notificationHandlers.get(method) ?? [];
      this.notificationHandlers.set(
        method,
        handlers.filter((h) => h !== handler),
      );
    };
  }

  close(): void {
    this.ws.close();
  }
}
