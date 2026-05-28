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
 * Max time to wait on a single `drain` before giving up. A remote that stops
 * reading but keeps the TCP connection open never fires `drain`; without this
 * cap the pending write — and every write queued behind it — would hang
 * forever, silently wedging the channel. On timeout we tear the socket down so
 * the relay's close→reconnect path recovers instead.
 */
const DRAIN_TIMEOUT_MS = 30_000;

/**
 * Queue a newline-delimited JSON message on `socket`, respecting backpressure.
 *
 * Resolves once the message has been handed to the kernel (write returned
 * true) or the previously-full buffer has drained. Rejects if the socket
 * errors before the write completes, or if `drain` doesn't fire within
 * `drainTimeoutMs` (in which case the socket is destroyed).
 *
 * Successive calls to the same socket queue in arrival order.
 */
export function writeJsonLine(
  socket: Socket,
  msg: Record<string, unknown>,
  drainTimeoutMs: number = DRAIN_TIMEOUT_MS,
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
        let drainTimer: ReturnType<typeof setTimeout> | undefined;

        function cleanup() {
          socket.removeListener("error", onError);
          socket.removeListener("drain", onDrain);
          if (drainTimer) clearTimeout(drainTimer);
        }
        function onError(err: Error) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        }
        function onDrain() {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        }
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
            cleanup();
            resolve();
          }
          return;
        }
        // Buffer full: resolve on 'drain', but bound the wait so a stalled
        // remote can't wedge this socket's whole write queue indefinitely.
        socket.once("drain", onDrain);
        drainTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          socket.destroy();
          reject(
            new Error(`socket write drain timeout after ${drainTimeoutMs}ms`),
          );
        }, drainTimeoutMs);
        drainTimer.unref?.();
      }),
  );
  // Swallow rejection from the chain so a single failed write doesn't stall
  // (and break) every subsequent write on this socket. Errors surface on the
  // returned promise of the failing call.
  const swallowed = next.catch(() => undefined);
  queues.set(socket, swallowed);
  return next;
}
