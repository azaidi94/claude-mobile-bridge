/**
 * Unit tests for /claude (src/handlers/commands/inject.ts): the generic
 * slash-command passthrough plus its no-arg command-reference listing.
 */

import "./ensure-test-env";
import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { SessionContext } from "../sessions/context";

let isAuthorizedImpl: () => boolean = () => true;
let resolveTopicSessionImpl: (action: string) => Promise<boolean> = async () =>
  false;
let resolveTopicSessionActions: string[] = [];
let sendKeysCalls: { sctx: SessionContext; text: string }[] = [];
let sendKeysImpl: (
  sctx: SessionContext,
  text: string,
) => Promise<{
  ok: boolean;
  note?: string;
  reason?: string;
  blocked?: boolean;
  launchUuid?: string;
  pane?: string;
  blockedHeadline?: string;
}> = async () => ({ ok: true });
let busReplyCalls: { content: string; opts?: unknown }[] = [];

mock.module("../config", () => ({ ALLOWED_USERS: [42] }));

mock.module("../security", () => ({
  isAuthorized: () => isAuthorizedImpl(),
}));

mock.module("../handlers/commands/helpers", () => ({
  busReply: (_ctx: unknown, content: string, opts?: unknown) => {
    busReplyCalls.push({ content, opts });
    return Promise.resolve();
  },
  resolveTopicSession: (_ctx: unknown, action: string) => {
    resolveTopicSessionActions.push(action);
    return resolveTopicSessionImpl(action);
  },
}));

mock.module("../handlers/commands/terminal-inject", () => ({
  sendKeysToSession: (sctx: SessionContext, text: string) => {
    sendKeysCalls.push({ sctx, text });
    return sendKeysImpl(sctx, text);
  },
}));

mock.module("../handlers/commands/tmux", () => ({
  replyBlockedPanel: mock(() => Promise.resolve()),
}));

function sctx(over: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: "sid-1",
    sessionDir: "/tmp",
    source: "cc",
    chatId: 1,
    sessionName: "s",
    ...over,
  };
}

function ctx(match: string | undefined, from = { id: 42 }): any {
  return {
    from,
    chat: { id: 1 },
    message: { message_thread_id: 5 },
    match,
  };
}

describe("/claude", () => {
  beforeEach(() => {
    isAuthorizedImpl = () => true;
    resolveTopicSessionImpl = async () => false;
    resolveTopicSessionActions = [];
    sendKeysCalls = [];
    sendKeysImpl = async () => ({ ok: true });
    busReplyCalls = [];
  });

  test("no argument: replies with the command reference, no injection", async () => {
    const { handleClaude } = await import("../handlers/commands/inject");
    await handleClaude(ctx(""), sctx());
    expect(sendKeysCalls.length).toBe(0);
    expect(busReplyCalls.length).toBe(1);
    expect(busReplyCalls[0]!.content).toContain("Claude Code slash commands");
    expect(busReplyCalls[0]!.content).toContain("/model");
    expect(busReplyCalls[0]!.opts).toBe("html");
  });

  test("with an argument: injects the slash command verbatim", async () => {
    const { handleClaude } = await import("../handlers/commands/inject");
    await handleClaude(ctx("model"), sctx());
    expect(sendKeysCalls.length).toBe(1);
    expect(sendKeysCalls[0]!.text).toBe("/model");
    expect(busReplyCalls[0]!.content).toBe("➡️ Sent /model.");
  });

  test("passes through multi-word arguments unchanged", async () => {
    const { handleClaude } = await import("../handlers/commands/inject");
    await handleClaude(ctx("plan add dark mode"), sctx());
    expect(sendKeysCalls[0]!.text).toBe("/plan add dark mode");
  });

  test("tolerates a leading slash typed by the user", async () => {
    const { handleClaude } = await import("../handlers/commands/inject");
    await handleClaude(ctx("/model"), sctx());
    expect(sendKeysCalls[0]!.text).toBe("/model");
  });

  test("blocks /claude exit without injecting", async () => {
    const { handleClaude } = await import("../handlers/commands/inject");
    await handleClaude(ctx("exit"), sctx());
    expect(sendKeysCalls.length).toBe(0);
    expect(busReplyCalls[0]!.content).toContain("blocked");
    expect(busReplyCalls[0]!.content).toContain("/kill");
  });

  test("blocks /claude quit without injecting", async () => {
    const { handleClaude } = await import("../handlers/commands/inject");
    await handleClaude(ctx("quit"), sctx());
    expect(sendKeysCalls.length).toBe(0);
  });

  test("blocks a double-slashed exit (name check and injection must agree)", async () => {
    const { handleClaude } = await import("../handlers/commands/inject");
    await handleClaude(ctx("//exit"), sctx());
    expect(sendKeysCalls.length).toBe(0);
    expect(busReplyCalls[0]!.content).toContain("blocked");
  });

  test("rejects a multi-line argument instead of injecting it verbatim", async () => {
    const { handleClaude } = await import("../handlers/commands/inject");
    await handleClaude(ctx("foo\nexit"), sctx());
    expect(sendKeysCalls.length).toBe(0);
    expect(busReplyCalls[0]!.content).toContain("single line");
  });

  test("outside a session topic: does not attempt the broken generic picker", async () => {
    const { handleClaude } = await import("../handlers/commands/inject");
    await handleClaude(ctx("resume"), undefined);
    expect(resolveTopicSessionActions).toEqual([]);
    expect(sendKeysCalls.length).toBe(0);
  });
});

describe("/clear, /compact, /context pickers", () => {
  beforeEach(() => {
    isAuthorizedImpl = () => true;
    resolveTopicSessionImpl = async () => false;
    resolveTopicSessionActions = [];
    sendKeysCalls = [];
    sendKeysImpl = async () => ({ ok: true });
    busReplyCalls = [];
  });

  test("/clear uses the clear_pick action callback.ts actually dispatches", async () => {
    const { handleClear } = await import("../handlers/commands/inject");
    await handleClear(ctx(""), undefined);
    expect(resolveTopicSessionActions).toEqual(["clear_pick"]);
  });

  test("/compact uses the compact_pick action callback.ts actually dispatches", async () => {
    const { handleCompact } = await import("../handlers/commands/inject");
    await handleCompact(ctx(""), undefined);
    expect(resolveTopicSessionActions).toEqual(["compact_pick"]);
  });

  test("/context uses the context_pick action callback.ts actually dispatches", async () => {
    const { handleContext } = await import("../handlers/commands/inject");
    await handleContext(ctx(""), undefined);
    expect(resolveTopicSessionActions).toEqual(["context_pick"]);
  });

  test("unauthorized user is rejected before injection", async () => {
    isAuthorizedImpl = () => false;
    const { handleClaude } = await import("../handlers/commands/inject");
    await handleClaude(ctx("model"), sctx());
    expect(sendKeysCalls.length).toBe(0);
    expect(busReplyCalls[0]!.content).toBe("Unauthorized.");
  });

  test("outside a session topic: tells the user where to run it", async () => {
    const { handleClaude } = await import("../handlers/commands/inject");
    await handleClaude(ctx("model"), undefined);
    expect(sendKeysCalls.length).toBe(0);
    expect(busReplyCalls[0]!.content).toContain(
      "Use /model in a Claude session topic.",
    );
  });

  test("non-cc session (e.g. cursor): explains it's unsupported", async () => {
    const { handleClaude } = await import("../handlers/commands/inject");
    await handleClaude(ctx("model"), sctx({ source: "cursor" }));
    expect(sendKeysCalls.length).toBe(0);
    expect(busReplyCalls[0]!.content).toContain(
      "isn't supported for cursor sessions",
    );
  });
});
