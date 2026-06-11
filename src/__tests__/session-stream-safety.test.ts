/**
 * Stream-side safety checks in runQueryStreaming must be report-only.
 *
 * The PreToolUse hook (enforceToolSafety) is the authoritative enforcement
 * point — it denies the tool before execution. The assistant event carrying
 * the tool_use block still streams through the event loop, so the stream-side
 * check fires too. It must notify (warn + BLOCKED status) but NOT abort the
 * query: aborting throws a non-cleanup error, sets state.lastError, and
 * leaves the session degraded (requires /retry) for an attempt the hook
 * already handled cleanly.
 */

import "./ensure-test-env";
import { describe, expect, test, mock } from "bun:test";
import type { StatusCallback } from "../types";

// Fake SDK: yields a scripted event stream instead of spawning Claude Code.
let scriptedEvents: unknown[] = [];
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () =>
    (async function* () {
      for (const event of scriptedEvents) yield event;
    })(),
}));

mock.module("../handlers/streaming", () => ({
  checkPendingAskUserRequests: () => Promise.resolve(false),
  checkPendingAskUserQuestionRequests: () => Promise.resolve(false),
}));

mock.module("../sessions", () => ({
  updateSessionId: () => {},
}));

mock.module("../settings", () => ({
  getDefaultModelSetting: () => undefined,
  saveSetting: () => Promise.resolve(),
  getWorkingDir: () => "/tmp/session-stream-safety-test",
}));

import { runQueryStreaming } from "../session";
import { SessionState } from "../sessions/session-state";

function makeToolUseEvent(
  name: string,
  input: Record<string, unknown>,
): unknown {
  return {
    type: "assistant",
    session_id: "sid-stream-safety",
    message: {
      content: [{ type: "tool_use", id: "tu-1", name, input }],
    },
  };
}

const resultEvent = {
  type: "result",
  session_id: "sid-stream-safety",
};

async function runWithEvents(
  events: unknown[],
): Promise<{ state: SessionState; statusCalls: [string, string][] }> {
  scriptedEvents = events;
  const state = new SessionState("stream-safety-test");
  const statusCalls: [string, string][] = [];
  const statusCallback: StatusCallback = async (type, content) => {
    statusCalls.push([type, content]);
  };
  await runQueryStreaming(state, {
    message: "please run it",
    username: "tester",
    userId: 1,
    statusCallback,
    model: "claude-sonnet-4-6",
  });
  return { state, statusCalls };
}

describe("stream-side safety is report-only (hook already denied)", () => {
  test("unsafe Bash tool_use reports BLOCKED without failing the query", async () => {
    const { state, statusCalls } = await runWithEvents([
      makeToolUseEvent("Bash", { command: "sudo rm -rf /etc" }),
      resultEvent,
    ]);

    const blocked = statusCalls.filter(
      ([type, content]) => type === "tool" && content.startsWith("BLOCKED:"),
    );
    expect(blocked.length).toBe(1);
    expect(state.lastError).toBeNull();
  });

  test("disallowed file path reports Access denied without failing the query", async () => {
    const { state, statusCalls } = await runWithEvents([
      makeToolUseEvent("Write", { file_path: "/etc/passwd", content: "x" }),
      resultEvent,
    ]);

    const denied = statusCalls.filter(
      ([type, content]) =>
        type === "tool" && content.startsWith("Access denied:"),
    );
    expect(denied.length).toBe(1);
    expect(state.lastError).toBeNull();
  });
});
