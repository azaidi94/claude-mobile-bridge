/**
 * Backpressure-aware newline-delimited JSON writer over a Node `net.Socket`.
 *
 * `socket.write` returns `false` when the kernel send buffer is full. If we
 * ignore that signal and keep enqueueing, Node grows its internal write queue
 * unboundedly — fine for small bursts, OOM-class problem for sustained slow
 * consumers. This helper serialises writes per-socket: each call awaits the
 * previous queue position, then either resolves immediately (`write === true`)
 * or waits for a single `drain` event before resolving.
 *
 * The wire format is unchanged — only timing differs.
 */
import type { Socket } from "net";

const queues = new WeakMap<Socket, Promise<void>>();

/**
 * Queue a newline-delimited JSON message on `socket`, respecting backpressure.
 *
 * Resolves once the message has been handed to the kernel (write returned
 * true) or the previously-full buffer has drained. Rejects if the socket
 * errors before the write completes.
 *
 * Successive calls to the same socket queue in arrival order.
 */
export function writeJsonLine(
  socket: Socket,
  msg: Record<string, unknown>,
): Promise<void> {
  const line = JSON.stringify(msg) + "\n";
  const prev = queues.get(socket) ?? Promise.resolve();
  const next = prev.then(
    () =>
      new Promise<void>((resolve, reject) => {
        // If the socket has already gone away, fail fast.
        if (socket.destroyed) {
          reject(new Error("socket destroyed"));
          return;
        }
        let settled = false;
        const onError = (err: Error) => {
          if (settled) return;
          settled = true;
          socket.removeListener("error", onError);
          reject(err);
        };
        socket.once("error", onError);

        const ok = socket.write(line, (err) => {
          if (err) {
            onError(err);
            return;
          }
          // If `write` returned true we can resolve here. If it returned
          // false we wait for 'drain' below.
        });
        if (ok) {
          if (!settled) {
            settled = true;
            socket.removeListener("error", onError);
            resolve();
          }
          return;
        }
        socket.once("drain", () => {
          if (settled) return;
          settled = true;
          socket.removeListener("error", onError);
          resolve();
        });
      }),
  );
  // Swallow rejection from the chain so a single failed write doesn't stall
  // (and break) every subsequent write on this socket. Errors surface on the
  // returned promise of the failing call.
  const swallowed = next.catch(() => undefined);
  queues.set(socket, swallowed);
  return next;
}
