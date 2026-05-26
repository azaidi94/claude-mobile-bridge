/**
 * Backpressure behaviour for writeJsonLine: when socket.write returns false,
 * the helper must wait for 'drain' before issuing the next write so messages
 * land in order and Node's internal queue doesn't grow unboundedly.
 */
import { describe, test, expect } from "bun:test";
import { EventEmitter } from "events";
import type { Socket } from "net";
import { writeJsonLine } from "../utils/socket-writer";

/**
 * Minimal Socket stand-in. `writeReturns` is a queue of booleans — each call
 * to write() pops the next value (defaulting to true). The mock records the
 * order in which writes are observed and exposes `emit('drain')` for the test
 * to advance the queue.
 */
function makeMockSocket(writeReturns: boolean[]): {
  socket: Socket;
  writes: string[];
} {
  const ee = new EventEmitter() as EventEmitter & Partial<Socket>;
  const writes: string[] = [];
  const queue = [...writeReturns];
  (ee as unknown as { destroyed: boolean }).destroyed = false;
  (ee as unknown as { write: (...args: unknown[]) => boolean }).write = (
    ...args: unknown[]
  ) => {
    const chunk = args[0];
    const cb = args.find((a) => typeof a === "function") as
      | ((err?: Error) => void)
      | undefined;
    writes.push(String(chunk));
    if (cb) cb();
    return queue.length > 0 ? queue.shift()! : true;
  };
  return { socket: ee as unknown as Socket, writes };
}

describe("writeJsonLine backpressure", () => {
  test("resolves immediately when write returns true", async () => {
    const { socket, writes } = makeMockSocket([true]);
    await writeJsonLine(socket, { type: "a" });
    expect(writes).toEqual([JSON.stringify({ type: "a" }) + "\n"]);
  });

  test("waits for drain before resolving when write returns false", async () => {
    const { socket } = makeMockSocket([false]);
    let resolved = false;
    const p = writeJsonLine(socket, { type: "slow" }).then(() => {
      resolved = true;
    });

    // Yield to the microtask queue; the write has gone through but resolution
    // is gated on the 'drain' event.
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);

    (socket as unknown as EventEmitter).emit("drain");
    await p;
    expect(resolved).toBe(true);
  });

  test("serialises successive writes so messages land in order", async () => {
    // First write fills the buffer (returns false), subsequent writes must
    // wait for drain. We enqueue three messages and verify ordering.
    const { socket, writes } = makeMockSocket([false, true, true]);

    const p1 = writeJsonLine(socket, { n: 1 });
    const p2 = writeJsonLine(socket, { n: 2 });
    const p3 = writeJsonLine(socket, { n: 3 });

    // After microtask flush only the first write should have happened —
    // the others are queued behind p1's pending drain.
    await new Promise((r) => setTimeout(r, 5));
    expect(writes.map((w) => JSON.parse(w))).toEqual([{ n: 1 }]);

    (socket as unknown as EventEmitter).emit("drain");
    await Promise.all([p1, p2, p3]);

    expect(writes.map((w) => JSON.parse(w))).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
    ]);
  });

  test("rejects when socket is already destroyed", async () => {
    const { socket } = makeMockSocket([true]);
    (socket as unknown as { destroyed: boolean }).destroyed = true;
    await expect(writeJsonLine(socket, { x: 1 })).rejects.toThrow(/destroyed/);
  });

  test("a single rejected write does not stall subsequent writes", async () => {
    const { socket, writes } = makeMockSocket([true, true]);
    // Make the first write reject by destroying the socket post-queue.
    (socket as unknown as { destroyed: boolean }).destroyed = true;
    const p1 = writeJsonLine(socket, { n: 1 });
    await expect(p1).rejects.toBeDefined();

    (socket as unknown as { destroyed: boolean }).destroyed = false;
    await writeJsonLine(socket, { n: 2 });
    expect(writes.map((w) => JSON.parse(w))).toEqual([{ n: 2 }]);
  });
});
