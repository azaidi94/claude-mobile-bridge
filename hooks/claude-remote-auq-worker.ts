#!/usr/bin/env bun
/**
 * AUQ-bridge worker. Spawned detached by claude-remote-auq-bridge.sh.
 * - POSTs the bridge request to the mobile-bridge bot.
 * - Long-polls for the answer.
 * - On answer: uses `tmux send-keys` to inject the answer into the CC TUI,
 *   but only after verifying the AUQ is still the on-screen modal.
 * - On cancellation: exits silently.
 *
 * M1: no global cap on concurrent worker processes. A skill that fires many
 * AskUserQuestion calls in a tight loop could accumulate long-running workers
 * (each runs up to 3 × 30s = 90s). Acceptable for M1; revisit if we see
 * resource pressure in practice.
 *
 * SAFETY — send-and-verify
 * ------------------------
 * The longpoll window is up to 90s. In that time the CC TUI can move on: the
 * AUQ may have been answered locally, or a *different* modal (Bash-permission,
 * trust prompt, sensitive-file edit, /model) can drift in. `tmux send-keys
 * Enter` into the wrong modal silently confirms its selected item — which can
 * approve a shell command or change a setting. So we never send a confirming
 * Enter without first capturing the pane and verifying the expected text
 * (the question, or the typed answer) is actually on screen.
 */

import { spawnSync } from "child_process";

interface WorkerInput {
  request_id: string;
  tool_use_id: string;
  session_id: string;
  cwd: string;
  tmux_pane: string;
  tool_input: {
    questions: Array<{ question: string; options: Array<{ label: string }> }>;
  };
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

// One TUI render tick. tmux send-keys returns immediately; the terminal needs
// a beat to repaint before capture-pane reflects the new state.
const RENDER_TICK_MS = 120;

function tick(ms = RENDER_TICK_MS): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tmux(args: string[]): { ok: boolean; stdout: string } {
  try {
    const r = spawnSync("tmux", args, { encoding: "utf-8" });
    return {
      ok: r.status === 0,
      stdout: typeof r.stdout === "string" ? r.stdout : "",
    };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function capturePane(pane: string): string {
  return tmux(["capture-pane", "-p", "-t", pane]).stdout;
}

/**
 * Does `paneText` contain `needle` (or a leading chunk of it)?
 *
 * Used to confirm a modal/answer is on screen before committing a confirming
 * Enter. Long strings are matched on a 30-char head — enough to be unique,
 * short enough to survive TUI line-wrapping. Whitespace is collapsed on both
 * sides so wrapped/padded renders still match. Strings shorter than `minLen`
 * fall back to an exact substring check (too short to head-match safely).
 */
export function paneContains(
  paneText: string,
  needle: string,
  minLen = 6,
): boolean {
  const trimmed = needle.trim();
  if (!trimmed) return false;
  // Drop box-drawing glyphs and pipes (TUI modal borders wrap text inside
  // them), then collapse whitespace, so a needle that spans a wrapped line
  // still matches.
  const norm = (s: string) =>
    s
      .replace(/[─-╿|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  if (trimmed.length < minLen) return norm(paneText).includes(norm(trimmed));
  return norm(paneText).includes(norm(trimmed.slice(0, 30)));
}

type InjectResult = "injected" | "skipped-not-visible" | "skipped-no-pane";

async function injectKeys(
  pane: string,
  question: { question: string; options: Array<{ label: string }> },
  answer: string,
): Promise<InjectResult> {
  if (!pane) return "skipped-no-pane";

  // Gate 1: the AUQ must still be the on-screen modal before we touch anything.
  if (!paneContains(capturePane(pane), question.question)) {
    console.error(
      `auq-bridge-worker: pane ${pane} no longer shows the AUQ — skipping key injection (answered locally or modal changed)`,
    );
    return "skipped-not-visible";
  }

  const optionIndex = question.options.findIndex((o) => o.label === answer);

  if (optionIndex >= 0) {
    // Labelled option: Escape clears stray input, the digit moves the
    // selection. A foreign modal would have swallowed the digit and replaced
    // the view, so re-verify the question is still visible before the
    // confirming Enter.
    tmux(["send-keys", "-t", pane, "Escape"]);
    await tick();
    tmux(["send-keys", "-t", pane, "-l", String(optionIndex + 1)]);
    await tick();
    if (!paneContains(capturePane(pane), question.question)) {
      console.error(
        `auq-bridge-worker: pane ${pane} changed after digit — skipping confirming Enter`,
      );
      return "skipped-not-visible";
    }
    tmux(["send-keys", "-t", pane, "Enter"]);
    return "injected";
  }

  // Custom free-text answer: select the "N+1. Type something" option, type the
  // answer literally (-l, so it can't trigger tmux keybindings), verify the
  // text actually landed in the input bar, then confirm.
  const typeOptionNumber = String(question.options.length + 1);
  tmux(["send-keys", "-t", pane, "Escape"]);
  await tick();
  tmux(["send-keys", "-t", pane, "-l", typeOptionNumber]);
  await tick();
  tmux(["send-keys", "-t", pane, "Enter"]); // opens the text field
  await tick();
  tmux(["send-keys", "-t", pane, "-l", answer]);
  await tick();
  if (!paneContains(capturePane(pane), answer, 2)) {
    console.error(
      `auq-bridge-worker: typed answer not visible in pane ${pane} — a modal likely swallowed it, skipping confirming Enter`,
    );
    return "skipped-not-visible";
  }
  tmux(["send-keys", "-t", pane, "Enter"]);
  return "injected";
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

  if (!postRes) {
    console.error(
      `auq-bridge-worker: POST ${BASE} failed (network) request_id=${input.request_id} cwd=${input.cwd}`,
    );
    return;
  }
  if (!postRes.ok) {
    const bodyText = await postRes.text().catch(() => "");
    console.error(
      `auq-bridge-worker: POST ${BASE} → HTTP ${postRes.status} ${bodyText} request_id=${input.request_id} cwd=${input.cwd}`,
    );
    return;
  }

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
      const outcome = await injectKeys(input.tmux_pane, q, a.answer);
      if (outcome !== "injected") {
        console.error(
          `auq-bridge-worker: answer for "${a.question}" not delivered to TUI (${outcome}) request_id=${input.request_id}`,
        );
      }
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("auq-bridge-worker:", err);
    process.exit(0);
  });
}
