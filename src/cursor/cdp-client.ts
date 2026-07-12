import { warn, debug } from "../logger";

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
    // The constructor installed drainPending as ws.onerror. Save it so we
    // can chain during connection setup, and restore it once connected so
    // post-connect errors still drain pending requests.
    const drainHandler = ws.onerror;
    ws.onopen = () => {
      ws.onerror = drainHandler;
      resolve(client);
    };
    ws.onerror = (err: unknown) => {
      drainHandler?.call(ws, err);
      reject(err);
    };
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
      // Wrap parse + dispatch — a single malformed frame must not throw out
      // of the handler. ws.onmessage is assigned once on connect; if it ever
      // throws, the runtime swallows the error and the bridge silently stops
      // receiving CDP events until reconnect. A handler-level handler also
      // catches throws inside the dispatched notification handlers below.
      let msg: {
        id?: number;
        method?: string;
        result?: unknown;
        error?: { message: string };
        params?: Record<string, unknown>;
      };
      try {
        msg = JSON.parse(String(event.data));
      } catch (err) {
        debug("cdp-client: dropping malformed CDP frame", {
          frame: event.data?.toString().slice(0, 120),
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      try {
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
      } catch (err) {
        warn("cdp-client: dispatch error", err, {
          method: msg.method ?? "id=" + msg.id,
        });
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
      // Reject fast on a dead socket — ws.send() silently discards on
      // CLOSING/CLOSED, so without this check the pending entry hangs
      // forever. The bridge's syncBridges loop has up to a 5 s window
      // between WS death and reconnection; messages injected in that
      // window would otherwise vanish with no log.
      if (this.ws.readyState !== 1) {
        reject(
          new Error(`WebSocket not open (readyState=${this.ws.readyState})`),
        );
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        reject(
          new Error(
            `WebSocket send failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
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

  /** True while the underlying WebSocket is OPEN (readyState === 1). */
  isAlive(): boolean {
    return this.ws.readyState === 1;
  }
}
