#!/usr/bin/env bun
/**
 * AUQ-bridge worker. Spawned detached by claude-remote-auq-bridge.sh.
 * - POSTs the bridge request to the mobile-bridge bot.
 * - Long-polls for the answer.
 * - On answer: uses `tmux send-keys` to inject the answer into the CC TUI.
 * - On cancellation: exits silently.
 *
 * M1: no global cap on concurrent worker processes. A skill that fires many
 * AskUserQuestion calls in a tight loop could accumulate long-running workers
 * (each runs up to 3 × 30s = 90s). Acceptable for M1; revisit if we see
 * resource pressure in practice.
 */

import { spawnSync } from "child_process";

interface WorkerInput {
  request_id: string;
  tool_use_id: string;
  session_id: string;
  cwd: string;
  tmux_pane: string;
  tool_input: { questions: Array<{ options: Array<{ label: string }> }> };
}

interface AnswerOk {
  status: "answered";
  answers: Array<{ question: string; answer: string }>;
}
interface AnswerCancelled {
  status: "cancelled";
  reason: string;
}
interface AnswerTimeout {
  status: "timeout";
}
type AnswerResp = AnswerOk | AnswerCancelled | AnswerTimeout;

const SECRET = process.env.RELAY_AUQ_SECRET ?? "";
const WEB_PORT = parseInt(process.env.WEB_PORT ?? "3000", 10);
const BASE = `http://localhost:${WEB_PORT}/api/auq-bridge`;
const AUTH = { Authorization: `Bearer ${SECRET}` };
const MAX_LONGPOLL_RETRIES = 3;

export function generateTmuxKeys(args: {
  pane: string;
  question: { options: Array<{ label: string }> };
  answer: string;
}): string[][] {
  const optionIndex = args.question.options.findIndex(
    (o) => o.label === args.answer,
  );
  if (optionIndex >= 0) {
    return [
      ["send-keys", "-t", args.pane, "Escape"],
      ["send-keys", "-t", args.pane, String(optionIndex + 1), "Enter"],
    ];
  }
  const typeOptionNumber = String(args.question.options.length + 1);
  return [
    ["send-keys", "-t", args.pane, "Escape"],
    ["send-keys", "-t", args.pane, typeOptionNumber, "Enter"],
    ["send-keys", "-t", args.pane, args.answer, "Enter"],
  ];
}

async function injectKeys(
  pane: string,
  question: { options: Array<{ label: string }> },
  answer: string,
): Promise<void> {
  if (!pane) return;
  const sequences = generateTmuxKeys({ pane, question, answer });
  for (const argv of sequences) {
    spawnSync("tmux", argv);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function readStdin(): Promise<string> {
  let buf = "";
  for await (const chunk of process.stdin) buf += String(chunk);
  return buf;
}

async function main(): Promise<void> {
  if (!SECRET) return;
  const inputRaw = await readStdin();
  const input = JSON.parse(inputRaw) as WorkerInput;

  const postRes = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH },
    body: JSON.stringify({
      request_id: input.request_id,
      tool_use_id: input.tool_use_id,
      session_id: input.session_id,
      cwd: input.cwd,
      questions: input.tool_input.questions,
      tmux_pane: input.tmux_pane,
    }),
  }).catch(() => null);

  if (!postRes || !postRes.ok) return;

  let result: AnswerResp | null = null;
  for (let i = 0; i < MAX_LONGPOLL_RETRIES; i++) {
    const r = await fetch(`${BASE}/${input.request_id}/answer`, {
      headers: AUTH,
    }).catch(() => null);
    if (!r) break;
    if (r.status === 408) continue;
    if (!r.ok) break;
    result = (await r.json()) as AnswerResp;
    break;
  }

  if (result?.status === "answered") {
    for (let i = 0; i < result.answers.length; i++) {
      const a = result.answers[i]!;
      const q = input.tool_input.questions[i]!;
      await injectKeys(input.tmux_pane, q, a.answer);
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("auq-bridge-worker:", err);
    process.exit(0);
  });
}
