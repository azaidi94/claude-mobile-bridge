#!/usr/bin/env bun
/**
 * PreToolUse gate for AskUserQuestion (the "force ask_remote when remote" policy).
 *
 * Decides per-invocation whether to ALLOW the native AskUserQuestion picker or
 * DENY it and tell the model to use mcp__channel-relay__ask_remote instead. The
 * rule is "last surface wins": if the most recent real user prompt in this
 * session came from Telegram (origin.kind === "channel"), the user is remote and
 * the native picker can't be answered from their phone — deny and route to
 * ask_remote. Otherwise (terminal, or unknown) allow the native picker.
 *
 * Surface is read from the session transcript's structured `origin.kind` field,
 * NOT from message text — a user pasting the words "channel-relay" is correctly
 * classified local. tool_result entries carry no origin.kind, so autonomous
 * tool activity after the user's last message never changes the verdict.
 *
 * FAIL-OPEN: any error, missing transcript, or ambiguity resolves to ALLOW. A
 * bug here must never block AskUserQuestion across the user's sessions.
 */

import { readdirSync, statSync, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export type Surface = "remote" | "local";

export function classifyOrigin(originKind: string | undefined): Surface | null {
  if (originKind === "channel") return "remote";
  if (originKind === "human") return "local";
  return null;
}

export function extractChannelChatId(text: string): string | undefined {
  const m = text.match(
    /<channel\s+source="channel-relay"[^>]*\bchat_id="(-?\d+)"/,
  );
  return m ? m[1] : undefined;
}

function userText(msg: { content?: unknown }): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter(
        (b): b is { type: string; text?: string } =>
          !!b &&
          typeof b === "object" &&
          (b as { type?: string }).type === "text",
      )
      .map((b) => b.text ?? "")
      .join(" ");
  }
  return "";
}

/**
 * Walk transcript lines newest-first; classify by the last real user prompt
 * (the last entry whose origin.kind is human or channel). Defaults to local.
 */
export function classifyTranscript(lines: string[]): {
  surface: Surface;
  chatId?: string;
} {
  for (let i = lines.length - 1; i >= 0; i--) {
    let o: {
      type?: string;
      message?: { role?: string; content?: unknown };
      origin?: { kind?: string };
    };
    try {
      o = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    if (o?.type !== "user" || o.message?.role !== "user") continue;
    const s = classifyOrigin(o.origin?.kind);
    if (s === null) continue; // tool_result / meta / non-surface prompt
    if (s === "remote") {
      return {
        surface: "remote",
        chatId: extractChannelChatId(userText(o.message)),
      };
    }
    return { surface: "local" };
  }
  return { surface: "local" };
}

const MAX_TAIL_BYTES = 5_000_000;

/** Locate <id>.jsonl under ~/.claude/projects/* and return its trailing lines. */
function readTranscriptTail(sessionId: string): string[] {
  const root = join(homedir(), ".claude", "projects");
  let path: string | null = null;
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, `${sessionId}.jsonl`);
    try {
      statSync(candidate);
      path = candidate;
      break;
    } catch {
      // not here
    }
  }
  if (!path) return [];
  const size = statSync(path).size;
  const start = Math.max(0, size - MAX_TAIL_BYTES);
  const len = size - start;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf-8").split("\n");
  // Drop a leading partial line if we started mid-file.
  if (start > 0) lines.shift();
  return lines.filter((l) => l.length > 0);
}

function allow(): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    }) + "\n",
  );
}

function deny(chatId?: string): void {
  const target = chatId ? ` (chat_id=${chatId})` : "";
  const reason =
    `You are driving this session from Telegram right now, where the native ` +
    `AskUserQuestion picker cannot be answered. Ask the same question via the ` +
    `mcp__channel-relay__ask_remote tool instead${target} — pass the chat_id and ` +
    `the same options so the user can tap an answer on their phone. The native ` +
    `AskUserQuestion was not shown.`;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n",
  );
}

async function main(): Promise<void> {
  let raw = "";
  try {
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw) as {
      tool_name?: string;
      session_id?: string;
    };
    if (input?.tool_name !== "AskUserQuestion") return allow();
    if (!input.session_id) return allow();
    const lines = readTranscriptTail(input.session_id);
    const { surface, chatId } = classifyTranscript(lines);
    if (surface === "remote") return deny(chatId);
    return allow();
  } catch {
    // FAIL-OPEN: never block AskUserQuestion on a gate error.
    return allow();
  }
}

if (import.meta.main) {
  main().catch(() => allow());
}
