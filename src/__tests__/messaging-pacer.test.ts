import "./ensure-test-env";
import { describe, test, expect } from "bun:test";
import { Bot } from "grammy";
import {
  createPacer,
  installPacerTransformer,
  laneFor,
  PacerOverloadError,
} from "../messaging/pacer";

// ---------------------------------------------------------------------------
// Virtual clock
//
// The pacer's only time dependencies are `now()` and `sleep()`, both
// injectable. Driving them from a fake clock makes every timing assertion
// exact instead of a wall-clock guess — no sleeps, no flake, no runtime.
// ---------------------------------------------------------------------------

interface Timer {
  at: number;
  resolve: () => void;
}

function fakeClock() {
  let t = 0;
  let timers: Timer[] = [];
  /** Let queued microtasks (and any real 0ms work) settle. */
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  return {
    now: () => t,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push({ at: t + ms, resolve });
      }),
    flush,
    /** Fire every pending timer in time order until none remain. */
    async drain(): Promise<void> {
      await flush();
      for (let guard = 0; guard < 10_000; guard++) {
        if (timers.length === 0) return;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift()!;
        t = Math.max(t, next.at);
        next.resolve();
        await flush();
      }
      throw new Error("drain: timers never settled");
    },
  };
}

/** A task that records the virtual time it ran at. */
function tracker(clock: { now: () => number }) {
  const order: string[] = [];
  const startedAt: Record<string, number> = {};
  return {
    order,
    startedAt,
    task:
      (label: string, durationMs = 0) =>
      async () => {
        order.push(label);
        startedAt[label] = clock.now();
        if (durationMs > 0) {
          // Occupy the slot for `durationMs` of virtual time without using the
          // pacer's own sleep, so the lane is genuinely held.
          const until = clock.now() + durationMs;
          while (clock.now() < until) await Promise.resolve();
        }
        return label;
      },
  };
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

describe("pacer — method classification", () => {
  test("sends, edits and pass-through methods are classified apart", () => {
    expect(laneFor("sendMessage")).toBe("send");
    expect(laneFor("sendPhoto")).toBe("send");
    expect(laneFor("sendMediaGroup")).toBe("send");
    expect(laneFor("editMessageText")).toBe("edit");
    expect(laneFor("editMessageReplyMarkup")).toBe("edit");
    // These don't spend the message budget, and queueing them behind it would
    // strand callback queries that expire in 15-30s.
    expect(laneFor("answerCallbackQuery")).toBeNull();
    expect(laneFor("deleteMessage")).toBeNull();
    expect(laneFor("sendChatAction")).toBeNull();
    expect(laneFor("pinChatMessage")).toBeNull();
    expect(laneFor("getUpdates")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pacing
// ---------------------------------------------------------------------------

describe("pacer — rate", () => {
  test("calls to one chat are spaced by the chat interval", async () => {
    const clock = fakeClock();
    const pacer = createPacer({
      chatSendPerMin: 60, // one per 1000ms
      chatSendBurst: 1, // sustained rate under test, not the burst
      now: clock.now,
      sleep: clock.sleep,
    });
    const t = tracker(clock);

    const all = Promise.all([
      pacer.pace("send", "-100", "sendMessage", t.task("a")),
      pacer.pace("send", "-100", "sendMessage", t.task("b")),
      pacer.pace("send", "-100", "sendMessage", t.task("c")),
    ]);
    await clock.drain();
    await all;

    expect(t.startedAt.a).toBe(0);
    expect(t.startedAt.b).toBe(1000);
    expect(t.startedAt.c).toBe(2000);
  });

  test("a forum's topics share one chat budget", async () => {
    // The production bug: Telegram's flood limit is per CHAT, so two topics
    // streaming at once must not each get the full rate. The pacer keys on
    // chat_id alone, so topic is not part of the lane identity.
    const clock = fakeClock();
    const pacer = createPacer({
      chatSendPerMin: 60,
      chatSendBurst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });
    const t = tracker(clock);

    const all = Promise.all([
      pacer.pace("send", "-100", "sendMessage", t.task("topicA-1")),
      pacer.pace("send", "-100", "sendMessage", t.task("topicB-1")),
      pacer.pace("send", "-100", "sendMessage", t.task("topicA-2")),
      pacer.pace("send", "-100", "sendMessage", t.task("topicB-2")),
    ]);
    await clock.drain();
    await all;

    // Four messages over three intervals — not two topics × full rate.
    expect(t.startedAt["topicB-2"]).toBe(3000);
  });

  test("a burst goes out at once, then the lane paces", async () => {
    // Telegram tolerates short bursts above the sustained ceiling. Strict
    // spacing would shed sends it would have accepted — a boot reconcile
    // fanning out across every live session is the case that bites.
    const clock = fakeClock();
    const pacer = createPacer({
      chatSendPerMin: 60, // one per 1000ms sustained
      chatSendBurst: 5,
      now: clock.now,
      sleep: clock.sleep,
    });
    const t = tracker(clock);

    const labels = ["b1", "b2", "b3", "b4", "b5", "b6", "b7"];
    const all = Promise.all(
      labels.map((l) => pacer.pace("send", "-100", "sendMessage", t.task(l))),
    );
    await clock.drain();
    await all;

    // The whole burst leaves immediately...
    for (const l of ["b1", "b2", "b3", "b4", "b5"]) {
      expect(t.startedAt[l]).toBe(0);
    }
    // ...then the lane falls back to the sustained rate.
    expect(t.startedAt.b6).toBe(1000);
    expect(t.startedAt.b7).toBe(2000);
  });

  test("separate chats do not block each other", async () => {
    const clock = fakeClock();
    const pacer = createPacer({
      chatSendPerMin: 60,
      chatSendBurst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });
    const t = tracker(clock);

    const all = Promise.all([
      pacer.pace("send", "-100", "sendMessage", t.task("chat1-a")),
      pacer.pace("send", "-100", "sendMessage", t.task("chat1-b")),
      pacer.pace("send", "-200", "sendMessage", t.task("chat2-a")),
    ]);
    await clock.drain();
    await all;

    expect(t.startedAt["chat1-b"]).toBe(1000);
    // A different chat has its own budget and starts immediately.
    expect(t.startedAt["chat2-a"]).toBe(0);
  });

  test("the edit lane is independent of the send lane", async () => {
    // Charging streaming edits to the 20/min send budget would pace a live
    // bubble far below STREAMING_THROTTLE_MS.
    const clock = fakeClock();
    const pacer = createPacer({
      chatSendPerMin: 60,
      chatSendBurst: 1,
      chatEditPerMin: 60_000, // effectively unpaced
      now: clock.now,
      sleep: clock.sleep,
    });
    const t = tracker(clock);

    const all = Promise.all([
      pacer.pace("send", "-100", "sendMessage", t.task("send-a")),
      pacer.pace("send", "-100", "sendMessage", t.task("send-b")),
      pacer.pace("edit", "-100", "editMessageText", t.task("edit-a")),
      pacer.pace("edit", "-100", "editMessageText", t.task("edit-b")),
    ]);
    await clock.drain();
    await all;

    expect(t.startedAt["send-b"]).toBe(1000);
    // Edits are not stuck behind the send backlog.
    expect(t.startedAt["edit-a"]).toBe(0);
    expect(t.startedAt["edit-b"]).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

describe("pacer — FIFO", () => {
  test("calls run in the order they were issued", async () => {
    const clock = fakeClock();
    const pacer = createPacer({
      chatSendPerMin: 60,
      chatSendBurst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });
    const t = tracker(clock);

    const all = Promise.all(
      ["m1", "m2", "m3", "m4", "m5"].map((label) =>
        pacer.pace("send", "-100", "sendMessage", t.task(label)),
      ),
    );
    await clock.drain();
    await all;

    expect(t.order).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  test("a slow call holds its slot — the next edit cannot overtake it", async () => {
    // This is the property that keeps a retried edit from landing after a
    // newer one and rewinding a streaming bubble: autoRetry's 429 backoff
    // runs inside the task, and the lane stays held for its duration.
    const clock = fakeClock();
    const pacer = createPacer({
      chatEditPerMin: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    const order: string[] = [];

    const slow = pacer.pace("edit", "-100", "editMessageText", async () => {
      // Simulates autoRetry sleeping on a retry_after inside our slot.
      await clock.sleep(5_000);
      order.push("stale-retried-edit");
    });
    const fresh = pacer.pace("edit", "-100", "editMessageText", async () => {
      order.push("fresh-edit");
    });

    await clock.drain();
    await Promise.all([slow, fresh]);

    // The newer edit is LAST, so it is the one left on screen.
    expect(order).toEqual(["stale-retried-edit", "fresh-edit"]);
  });

  test("a rejected call does not wedge the lane behind it", async () => {
    const clock = fakeClock();
    const pacer = createPacer({
      chatSendPerMin: 60,
      chatSendBurst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });
    const order: string[] = [];

    // Attach the handler at creation — the rejection lands before drain().
    const failing = pacer
      .pace("send", "-100", "sendMessage", async () => {
        order.push("boom");
        throw new Error("400: Bad Request");
      })
      .catch((err: Error) => err);
    const after = pacer.pace("send", "-100", "sendMessage", async () => {
      order.push("after");
    });

    await clock.drain();
    expect((await failing).message).toBe("400: Bad Request");
    await after;
    expect(order).toEqual(["boom", "after"]);
  });
});

// ---------------------------------------------------------------------------
// bounded waiting
// ---------------------------------------------------------------------------

describe("pacer — bounded waiting", () => {
  test("a call that would wait past the deadline is rejected, not held", async () => {
    // Callers await the bus inside sequentialize and ticking-guarded loops —
    // an unbounded wait stalls a topic's whole update queue, so past the
    // deadline a fast failure beats a late success.
    const clock = fakeClock();
    const pacer = createPacer({
      chatSendPerMin: 6, // one per 10s
      chatSendBurst: 1,
      sendDeadlineMs: 15_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    const t = tracker(clock);

    const results = Promise.allSettled([
      pacer.pace("send", "-100", "sendMessage", t.task("a")), // t=0
      pacer.pace("send", "-100", "sendMessage", t.task("b")), // t=10s, ok
      pacer.pace("send", "-100", "sendMessage", t.task("c")), // t=20s > 15s
    ]);
    await clock.drain();
    const [a, b, c] = await results;

    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    expect(c.status).toBe("rejected");
    expect((c as PromiseRejectedResult).reason).toBeInstanceOf(
      PacerOverloadError,
    );
    expect(t.order).toEqual(["a", "b"]);
  });

  test("depth cap rejects immediately instead of growing the queue", async () => {
    const clock = fakeClock();
    const pacer = createPacer({
      chatSendPerMin: 6,
      chatSendBurst: 1,
      maxLaneDepth: 3,
      now: clock.now,
      sleep: clock.sleep,
    });
    const t = tracker(clock);

    const queued = [
      pacer.pace("send", "-100", "sendMessage", t.task("a")),
      pacer.pace("send", "-100", "sendMessage", t.task("b")),
      pacer.pace("send", "-100", "sendMessage", t.task("c")),
    ];
    expect(pacer.depth("send", "-100")).toBe(3);

    // The 4th is refused synchronously — before any await.
    const overflow = pacer.pace("send", "-100", "sendMessage", t.task("d"));
    await expect(overflow).rejects.toBeInstanceOf(PacerOverloadError);

    await clock.drain();
    await Promise.allSettled(queued);
    expect(t.order).not.toContain("d");
  });

  test("depth returns to zero once the lane drains", async () => {
    const clock = fakeClock();
    const pacer = createPacer({
      chatSendPerMin: 60,
      chatSendBurst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });
    const t = tracker(clock);

    const all = Promise.all([
      pacer.pace("send", "-100", "sendMessage", t.task("a")),
      pacer.pace("send", "-100", "sendMessage", t.task("b")),
    ]);
    await clock.drain();
    await all;

    expect(pacer.depth("send", "-100")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// transformer wiring
// ---------------------------------------------------------------------------

describe("pacer — transformer", () => {
  /** Capture the transformer `installPacerTransformer` registers. */
  function install(opts: Parameters<typeof installPacerTransformer>[1] = {}) {
    let transformer: any;
    const api = {
      config: {
        use: (fn: any) => {
          transformer = fn;
        },
      },
    };
    installPacerTransformer(api as any, opts);
    return transformer!;
  }

  test("paces sendMessage but lets answerCallbackQuery straight through", async () => {
    const clock = fakeClock();
    const transformer = install({
      chatSendPerMin: 60,
      chatSendBurst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });
    const ranAt: Record<string, number> = {};
    const prev = async (method: string) => {
      ranAt[method] = clock.now();
      return { ok: true, result: {} } as any;
    };

    const sends = Promise.all([
      transformer(prev, "sendMessage", { chat_id: -100, text: "a" }, undefined),
      transformer(prev, "sendMessage", { chat_id: -100, text: "b" }, undefined),
    ]);
    // Issued while the send lane is backed up; must not be delayed by it.
    const cb = transformer(
      prev,
      "answerCallbackQuery",
      { callback_query_id: "1" },
      undefined,
    );

    await cb;
    expect(ranAt.answerCallbackQuery).toBe(0);

    await clock.drain();
    await sends;
    expect(ranAt.sendMessage).toBe(1000); // second call's timestamp
  });

  test("installing last makes the pacer wrap earlier transformers", async () => {
    // Load-bearing and silent if it regresses: grammy's concatTransformer
    // wraps the existing chain, so the LAST transformer installed is called
    // FIRST. bot.ts relies on this to install the pacer after autoRetry, so
    // autoRetry's 429 backoff sleeps inside the chat's slot rather than
    // racing other calls into the same flood window.
    const clock = fakeClock();
    const bot = new Bot("12345:test-token");
    const innerRanAt: number[] = [];
    // Installed FIRST → innermost. Short-circuits, so nothing hits the network.
    bot.api.config.use(async (_prev, _method, _payload) => {
      innerRanAt.push(clock.now());
      return { ok: true, result: { message_id: 1 } } as any;
    });
    // Installed LAST → outermost.
    installPacerTransformer(bot.api, {
      chatSendPerMin: 60,
      chatSendBurst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });

    const calls = Promise.all([
      bot.api.sendMessage(-100, "a"),
      bot.api.sendMessage(-100, "b"),
    ]);
    await clock.drain();
    await calls;

    // The inner transformer sees the SECOND call already paced. Were the
    // pacer innermost, the inner one would have run twice at t=0.
    expect(innerRanAt).toEqual([0, 1000]);
  });

  test("a call with no chat_id is not paced", async () => {
    const clock = fakeClock();
    const transformer = install({
      chatSendPerMin: 1, // one per minute — would be a long wait if paced
      now: clock.now,
      sleep: clock.sleep,
    });
    let calls = 0;
    const prev = async () => {
      calls++;
      return { ok: true, result: {} } as any;
    };

    // Inline-message edits carry inline_message_id, never chat_id.
    await transformer(
      prev,
      "editMessageText",
      { inline_message_id: "abc", text: "x" },
      undefined,
    );
    await transformer(
      prev,
      "editMessageText",
      { inline_message_id: "abc", text: "y" },
      undefined,
    );
    expect(calls).toBe(2);
  });

  test("the underlying error is preserved through the pacer", async () => {
    const clock = fakeClock();
    const transformer = install({ now: clock.now, sleep: clock.sleep });
    const prev = async () => {
      throw new Error("429: Too Many Requests: retry after 5");
    };
    await expect(
      transformer(prev, "sendMessage", { chat_id: -100, text: "x" }, undefined),
    ).rejects.toThrow("429: Too Many Requests: retry after 5");
  });
});
