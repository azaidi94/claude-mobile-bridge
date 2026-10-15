import { test, expect } from "bun:test";
import {
  PullInbox,
  channelsEnabledIn,
  INBOX_CAP,
  MESSAGE_TTL_MS,
  POLLER_GRACE_MS,
  type InboundMessage,
} from "./pull-inbox";

const msg = (content: string): InboundMessage => ({
  content,
  meta: { chat_id: "1", request_id: content },
});

test("inactive until polled, active within grace, inactive after", async () => {
  let now = 1_000_000;
  const inbox = new PullInbox(() => now);
  expect(inbox.isActive()).toBe(false);
  inbox.enqueue(msg("a"));
  await inbox.poll(10);
  expect(inbox.isActive()).toBe(true);
  now += POLLER_GRACE_MS + 1;
  expect(inbox.isActive()).toBe(false);
});

test("queued messages drain on the next poll, in order", async () => {
  const inbox = new PullInbox();
  inbox.enqueue(msg("a"));
  inbox.enqueue(msg("b"));
  expect((await inbox.poll(10)).map((m) => m.content)).toEqual(["a", "b"]);
  expect(await inbox.poll(5)).toEqual([]);
});

test("a waiting poll resolves on enqueue", async () => {
  const inbox = new PullInbox();
  const pending = inbox.poll(5_000);
  expect(inbox.isActive()).toBe(true);
  inbox.enqueue(msg("x"));
  expect((await pending).map((m) => m.content)).toEqual(["x"]);
});

test("a newer poll supersedes the waiting one", async () => {
  const inbox = new PullInbox();
  const first = inbox.poll(5_000);
  const second = inbox.poll(5_000);
  expect(await first).toEqual([]);
  inbox.enqueue(msg("y"));
  expect((await second).map((m) => m.content)).toEqual(["y"]);
});

test("queue is capped, oldest dropped and reported", async () => {
  const dropped: string[] = [];
  const inbox = new PullInbox(Date.now, (reason, m) =>
    dropped.push(`${reason}:${m.content}`),
  );
  for (let i = 0; i < INBOX_CAP + 5; i++) inbox.enqueue(msg(String(i)));
  const got = await inbox.poll(10);
  expect(got.length).toBe(INBOX_CAP);
  expect(got[0]!.content).toBe("5");
  expect(dropped).toEqual(["cap:0", "cap:1", "cap:2", "cap:3", "cap:4"]);
});

test("messages older than the TTL expire unpolled", async () => {
  let now = 1_000_000;
  const dropped: string[] = [];
  const inbox = new PullInbox(
    () => now,
    (reason, m) => dropped.push(`${reason}:${m.content}`),
  );
  inbox.enqueue(msg("old"));
  now += MESSAGE_TTL_MS - 1_000;
  inbox.enqueue(msg("fresh"));
  now += 2_000;
  expect((await inbox.poll(10)).map((m) => m.content)).toEqual(["fresh"]);
  expect(dropped).toEqual(["expired:old"]);
});

// Regression: a poll whose client hung up kept waiting, and the next message
// was handed to the dead connection and lost.
test("an aborted poll stops waiting; the next message queues", async () => {
  const inbox = new PullInbox();
  const ac = new AbortController();
  const pending = inbox.poll(5_000, ac.signal);
  ac.abort();
  expect(await pending).toEqual([]);
  inbox.enqueue(msg("z"));
  expect((await inbox.poll(10)).map((m) => m.content)).toEqual(["z"]);
});

test("a poll already aborted drains nothing", async () => {
  const inbox = new PullInbox();
  inbox.enqueue(msg("keep"));
  const ac = new AbortController();
  ac.abort();
  expect(await inbox.poll(5_000, ac.signal)).toEqual([]);
  expect((await inbox.poll(10)).map((m) => m.content)).toEqual(["keep"]);
});

test("a timed-out poll leaves later messages queued", async () => {
  const inbox = new PullInbox();
  expect(await inbox.poll(5)).toEqual([]);
  inbox.enqueue(msg("later"));
  expect((await inbox.poll(10)).map((m) => m.content)).toEqual(["later"]);
});

test("grace runs from when a waiting poll ends, not when it began", async () => {
  let now = 1_000_000;
  const inbox = new PullInbox(() => now);
  const pending = inbox.poll(5);
  now += POLLER_GRACE_MS + 1;
  await pending; // timed out "now", long after it began
  expect(inbox.isActive()).toBe(true);
});

test("channelsEnabledIn detects the launch flags", () => {
  expect(
    channelsEnabledIn(
      "claude --dangerously-load-development-channels server:channel-relay",
    ),
  ).toBe(true);
  expect(channelsEnabledIn("claude --channels server:x")).toBe(true);
  expect(
    channelsEnabledIn(
      "/Applications/Claude.app/.../claude --output-format stream-json",
    ),
  ).toBe(false);
  expect(channelsEnabledIn("")).toBe(false);
});

test("channelsEnabledIn matches whole flags only", () => {
  expect(channelsEnabledIn("claude --channels=server:x")).toBe(true);
  expect(
    channelsEnabledIn(
      "claude --dangerously-load-development-channels=server:channel-relay",
    ),
  ).toBe(true);
  expect(channelsEnabledIn("claude --channels")).toBe(true);
  expect(channelsEnabledIn("claude --channels-foo x")).toBe(false);
  expect(channelsEnabledIn("claude --no--channels x")).toBe(false);
});
