import { describe, test, expect, beforeEach } from "bun:test";
import {
  pendingClaudeArg,
  takePendingClaudeArg,
  PENDING_CLAUDE_ARG_TTL_MS,
} from "../menus/claude-pending";

describe("takePendingClaudeArg", () => {
  beforeEach(() => pendingClaudeArg.clear());

  test("nothing pending → null, message untouched", () => {
    expect(takePendingClaudeArg("k", "hello")).toBeNull();
  });

  test("pending + text → sends /name <text> once", () => {
    pendingClaudeArg.set("k", { name: "btw", createdAt: 1000 });
    expect(takePendingClaudeArg("k", "  is this safe? ", 2000)).toEqual({
      kind: "send",
      slash: "/btw is this safe?",
      label: "➡️ Sent /btw is this safe?.",
    });
    expect(takePendingClaudeArg("k", "again", 2000)).toBeNull();
  });

  test("/cancel or empty → cancel", () => {
    pendingClaudeArg.set("k", { name: "btw", createdAt: 1000 });
    expect(takePendingClaudeArg("k", "/cancel", 2000)).toEqual({
      kind: "cancel",
    });
    pendingClaudeArg.set("k", { name: "btw", createdAt: 1000 });
    expect(takePendingClaudeArg("k", "   ", 2000)).toEqual({ kind: "cancel" });
  });

  test("newlines are flattened so one Enter submits the whole command", () => {
    pendingClaudeArg.set("k", { name: "goal", createdAt: 1000 });
    expect(takePendingClaudeArg("k", "a\nb\r\nc", 2000)).toMatchObject({
      slash: "/goal a b c",
    });
  });

  test("expired entries are dropped and the message falls through", () => {
    pendingClaudeArg.set("k", { name: "btw", createdAt: 1000 });
    expect(
      takePendingClaudeArg("k", "late", 1000 + PENDING_CLAUDE_ARG_TTL_MS + 1),
    ).toBeNull();
    expect(pendingClaudeArg.has("k")).toBe(false);
  });
});
