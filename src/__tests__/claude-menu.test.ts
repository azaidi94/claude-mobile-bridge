import { describe, test, expect, beforeEach, mock } from "bun:test";

const replies: string[] = [];
mock.module("../handlers/commands/helpers", () => ({
  busReply: async (_ctx: unknown, text: string) => {
    replies.push(text);
  },
}));

import {
  claudeMenuSpec,
  claudeGroupMenuSpec,
  claudeOptionsMenuSpec,
  optionsFor,
  registerClaudeMenu,
  CLAUDE_CMD_KIND,
  CLAUDE_GROUP_KIND,
  CLAUDE_HELP_KIND,
  CLAUDE_ASK_KIND,
} from "../menus/claude-menu";
import { pendingClaudeArg } from "../menus/claude-pending";
import {
  CLAUDE_COMMANDS,
  type CommandGroup,
} from "../handlers/commands/claude-command-reference";
import { handleMenuCallback, _resetMenuKindsForTests } from "../menus/menu";
import { putToken, _resetMenuRegistryForTests } from "../menus/registry";

const groups: CommandGroup[] = [
  {
    title: "Session",
    commands: [
      { name: "/clear", purpose: "x" },
      { name: "/exit", purpose: "blocked" },
      { name: "/model", purpose: "x", options: ["opus", "sonnet"] },
      {
        name: "/btw",
        purpose: "x",
        arg: "required",
        argHint: "your side question",
      },
      {
        name: "/code-review",
        purpose: "x",
        arg: "optional",
        argHint: "a target",
      },
    ],
  },
  { title: "Only blocked", commands: [{ name: "/quit", purpose: "blocked" }] },
];

describe("claude menu specs", () => {
  test("top level lists groups (minus all-blocked ones) plus the text reference", () => {
    const spec = claudeMenuSpec(groups);
    expect(spec.items.map((i) => i.label)).toEqual([
      "Session",
      "📖 Full reference (text)",
    ]);
    expect(spec.items[0]?.kind).toBe(CLAUDE_GROUP_KIND);
    expect(spec.items.at(-1)?.kind).toBe(CLAUDE_HELP_KIND);
  });

  test("group level never offers blocklisted commands", () => {
    const spec = claudeGroupMenuSpec(0, groups);
    expect(spec.items.map((i) => i.label)).toEqual([
      "/clear",
      "/model",
      "/btw",
      "/code-review",
    ]);
    expect(spec.items[0]?.payload).toEqual({ name: "clear" });
    expect(spec.back?.kind).toBe(CLAUDE_GROUP_KIND);
  });

  test("real reference contains no blocklisted names", () => {
    for (let i = 0; ; i++) {
      const spec = claudeGroupMenuSpec(i, CLAUDE_COMMANDS);
      if (spec.title === "🤖 Claude Code commands") break; // out of range → top level
      for (const it of spec.items)
        expect(["/exit", "/quit"]).not.toContain(it.label);
    }
  });

  test("options level", () => {
    expect(optionsFor("/model", groups)).toEqual(["opus", "sonnet"]);
    expect(optionsFor("clear", groups)).toBeUndefined();
    const spec = claudeOptionsMenuSpec("model", ["opus"]);
    expect(spec.items[0]?.payload).toEqual({ name: "model", arg: "opus" });
  });
});

describe("claude.cmd handler", () => {
  const inject = mock(async () => {});
  const answers: unknown[] = [];
  const edits: string[] = [];
  let sctx: unknown = { sessionName: "kx_repo", source: "cc" };
  const ctx = {
    chat: { id: 1 },
    from: { id: 42 },
    answerCallbackQuery: async (o?: unknown) => {
      answers.push(o ?? {});
    },
    editMessageText: async (t: string) => {
      edits.push(t);
    },
  };

  beforeEach(() => {
    _resetMenuRegistryForTests();
    _resetMenuKindsForTests();
    inject.mockClear();
    answers.length = 0;
    edits.length = 0;
    replies.length = 0;
    sctx = { sessionName: "kx_repo", source: "cc" };
    registerClaudeMenu({
      inject: inject as never,
      resolveSctx: () => sctx as never,
      groups,
    });
  });

  test("a plain command is injected into the topic's session", async () => {
    const t = putToken({
      kind: CLAUDE_CMD_KIND,
      payload: { name: "clear" },
      chatId: 1,
    });
    await handleMenuCallback(ctx as never, t);
    expect(inject).toHaveBeenCalledWith(ctx, sctx, "/clear", "➡️ Sent /clear.");
  });

  test("blocklisted command token is refused", async () => {
    for (const name of [
      "exit",
      "quit",
      "/exit",
      "EXIT",
      "//exit",
      "exit now",
    ]) {
      inject.mockClear();
      const t = putToken({
        kind: CLAUDE_CMD_KIND,
        payload: { name },
        chatId: 1,
      });
      await handleMenuCallback(ctx as never, t);
      expect(inject).not.toHaveBeenCalled();
      expect(String((answers.at(-1) as { text: string }).text)).toContain(
        "blocked",
      );
    }
  });

  test("a command with options shows the options menu first, then injects with the arg", async () => {
    const t = putToken({
      kind: CLAUDE_CMD_KIND,
      payload: { name: "model" },
      chatId: 1,
    });
    await handleMenuCallback(ctx as never, t);
    expect(inject).not.toHaveBeenCalled();
    expect(edits[0]).toBe("/model …");
    const t2 = putToken({
      kind: CLAUDE_CMD_KIND,
      payload: { name: "model", arg: "opus" },
      chatId: 1,
    });
    await handleMenuCallback(ctx as never, t2);
    expect(inject).toHaveBeenCalledWith(
      ctx,
      sctx,
      "/model opus",
      "➡️ Sent /model opus.",
    );
  });

  test("a command that REQUIRES text asks for it and waits instead of sending", async () => {
    pendingClaudeArg.clear();
    const t = putToken({
      kind: CLAUDE_CMD_KIND,
      payload: { name: "btw" },
      chatId: 1,
    });
    await handleMenuCallback(
      { ...ctx, msg: { message_thread_id: 77 } } as never,
      t,
    );
    expect(inject).not.toHaveBeenCalled();
    expect(replies[0]).toContain("/btw");
    expect(replies[0]).toContain("your side question");
    expect([...pendingClaudeArg.values()].map((p) => p.name)).toEqual(["btw"]);
  });

  test("a command with OPTIONAL text offers 'send as is' or 'enter text'", async () => {
    pendingClaudeArg.clear();
    const t = putToken({
      kind: CLAUDE_CMD_KIND,
      payload: { name: "code-review" },
      chatId: 1,
    });
    await handleMenuCallback(ctx as never, t);
    expect(inject).not.toHaveBeenCalled();
    expect(edits[0]).toContain("/code-review — add text?");
    const asIs = putToken({
      kind: CLAUDE_CMD_KIND,
      payload: { name: "code-review", arg: "" },
      chatId: 1,
    });
    await handleMenuCallback(ctx as never, asIs);
    expect(inject).toHaveBeenCalledWith(
      ctx,
      sctx,
      "/code-review",
      "➡️ Sent /code-review.",
    );
    const ask = putToken({
      kind: CLAUDE_ASK_KIND,
      payload: { name: "code-review" },
      chatId: 1,
    });
    await handleMenuCallback(ctx as never, ask);
    expect([...pendingClaudeArg.values()].map((p) => p.name)).toEqual([
      "code-review",
    ]);
  });

  test("outside a session topic the tap is refused with an alert", async () => {
    sctx = undefined;
    const t = putToken({
      kind: CLAUDE_CMD_KIND,
      payload: { name: "clear" },
      chatId: 1,
    });
    await handleMenuCallback(ctx as never, t);
    expect(inject).not.toHaveBeenCalled();
    expect(answers[0]).toMatchObject({ show_alert: true });
  });

  test("group tap replaces with the group's commands; Back returns to top", async () => {
    const t = putToken({
      kind: CLAUDE_GROUP_KIND,
      payload: { index: 0 },
      chatId: 1,
    });
    await handleMenuCallback(ctx as never, t);
    expect(edits[0]).toBe("🤖 Session");
    const back = putToken({
      kind: CLAUDE_GROUP_KIND,
      payload: { index: -1 },
      chatId: 1,
    });
    await handleMenuCallback(ctx as never, back);
    expect(edits[1]).toBe("🤖 Claude Code commands");
  });

  test("help tap posts the text reference", async () => {
    const t = putToken({ kind: CLAUDE_HELP_KIND, payload: null, chatId: 1 });
    await handleMenuCallback(ctx as never, t);
    expect(replies[0]).toContain("/clear");
  });
});
